import dotenv from "dotenv";
import mongoose from "mongoose";
import { parentPort, threadId } from "worker_threads";
import {
  JobType,
  WorkerJobData,
  WorkerMessage,
  WorkerMessageType,
} from "../common/worker-types.js";

// Import the main functions
import {
  BookingErrorType,
  getBookingErrorDescription,
  shouldRetryBookingError,
} from "../common/booking-error-types.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
  setCurrentWorkerId,
} from "../common/log-helper.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { mainMultiPlatform } from "../main-multi-platform.js";
import { JobStatus } from "../models/job.model.js";
import reservation from "../reservation/reservation.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobService } from "../services/job.service.js";
import { notificationService } from "../services/notification.service.js";

// Global function to release OTP from worker
(global as any).releaseOtpFromWorker = (jobId: string) => {
  if (parentPort) {
    parentPort.postMessage({
      type: "otp-release",
      jobId,
      data: { message: "OTP released from worker" },
      timestamp: new Date(),
    });
  }
};

// Load environment variables
dotenv.config();

class ScrapingWorker {
  private currentJobId?: string;
  private isShuttingDown = false;

  constructor() {
    // Set the thread ID for logging immediately when worker starts
    // Worker threads will be Thread-2, Thread-3, Thread-4, etc.
    setCurrentWorkerId(`Thread-${threadId}`);
    console.log(`Worker initialized on Thread-${threadId}`);

    this.setupEventHandlers();
    this.initializeDatabase();
  }

  private setupEventHandlers(): void {
    if (!parentPort) {
      throw new Error("Worker must be run as a worker thread");
    }

    // Listen for messages from main thread (both job data and stop commands)
    parentPort.on("message", async (message: any) => {
      // Handle stop command
      if (message.type === "stop" && message.jobId) {
        console.log(`Worker: Received stop command for job ${message.jobId}`);
        const state = scrapingStateManager.getState();
        const isCurrentJob =
          this.currentJobId === message.jobId ||
          state.currentJobId === message.jobId;

        if (isCurrentJob) {
          // Stop scraping gracefully
          scrapingStateManager.stopScraping();
          console.log(`Worker: Stopped scraping for job ${message.jobId}`);

          // Send acknowledgment
          this.sendMessage({
            type: WorkerMessageType.JobProgress,
            jobId: message.jobId,
            data: {
              message: `Job ${message.jobId} stopped by user request`,
              stopped: true,
            },
            timestamp: new Date(),
          });
        } else {
          console.log(
            `Worker: Stop command received for job ${
              message.jobId
            }, but current job is ${
              this.currentJobId || state.currentJobId || "none"
            }`
          );
        }
        return;
      }

      // Handle job data (existing logic)
      const jobData = message as WorkerJobData;
      try {
        await this.executeJob(jobData);
      } catch (error) {
        this.sendMessage({
          type: WorkerMessageType.JobError,
          jobId: jobData.jobId,
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
          timestamp: new Date(),
        });
      }
    });

    // Handle shutdown gracefully
    process.on("SIGTERM", () => {
      this.shutdown();
    });

    process.on("SIGINT", () => {
      this.shutdown();
    });
  }

  private async initializeDatabase(): Promise<void> {
    try {
      const DATABASE_URI = process.env.DATABASE_URI;
      if (!DATABASE_URI) {
        throw new Error("DATABASE_URI environment variable is not defined");
      }

      await mongoose.connect(DATABASE_URI);
      console.log("Worker: Connected to MongoDB successfully");
    } catch (error) {
      console.error("Worker: MongoDB connection error:", error);
      throw error;
    }
  }

  private sendMessage(message: WorkerMessage): void {
    if (parentPort && !this.isShuttingDown) {
      parentPort.postMessage(message);
    }
  }

  private async executeJob(jobData: WorkerJobData): Promise<void> {
    this.currentJobId = jobData.jobId;

    this.sendMessage({
      type: WorkerMessageType.JobStart,
      jobId: jobData.jobId,
      data: { jobType: jobData.jobType, startTime: new Date(), threadId },
      timestamp: new Date(),
    });

    try {
      let result;

      switch (jobData.jobType) {
        case JobType.PropertyRun:
          result = await this.handlePropertyRun(jobData);
          break;

        case JobType.RerunFailed:
          result = await this.handleRerunFailed(jobData);
          break;

        case JobType.ReservationRun:
          result = await this.handleReservationRun(jobData);
          break;

        case JobType.BookingRun:
          result = await this.handleBookingRun(jobData);
          break;

        case JobType.BookingRerunFailed:
          result = await this.handleBookingRerunFailed(jobData);
          break;

        default:
          throw new Error(`Unknown job type: ${jobData.jobType}`);
      }

      this.sendMessage({
        type: WorkerMessageType.JobComplete,
        jobId: jobData.jobId,
        data: result,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`Worker job ${jobData.jobId} failed:`, error);

      this.sendMessage({
        type: WorkerMessageType.JobError,
        jobId: jobData.jobId,
        data: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        timestamp: new Date(),
      });
    } finally {
      this.currentJobId = undefined;
    }
  }

  private async handlePropertyRun(jobData: WorkerJobData): Promise<any> {
    const { jobId, startDate, endDate, expediaId, user_email, user_password } =
      jobData;

    if (!startDate || !endDate || !jobId) {
      throw new Error(
        "startDate, endDate, and jobId are required for property-run jobs"
      );
    }

    // 1. Validate job exists and can be run
    const validation = await jobService.validateJob(jobId);

    if (!validation.exists) {
      throw new Error(`Job with ID ${jobId} not found`);
    }

    if (!validation.canRun) {
      throw new Error(
        `Job ${jobId} is not in a runnable state. Current status: ${validation.job?.job_status}`
      );
    }

    // 2. Get expedia_id from job's property if not provided
    let finalExpediaId = expediaId;
    let finalUserEmail = user_email;
    let finalUserPassword = user_password;

    if (!finalExpediaId || !finalUserEmail || !finalUserPassword) {
      console.log(`Getting job data for job ${jobId}...`);
      const jobData = await jobService.getExpediaIdFromJob(jobId);

      if (!jobData || !jobData.expediaId) {
        throw new Error(
          `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`
        );
      }

      if (!jobData.user_email || !jobData.user_password) {
        throw new Error(
          `Cannot retrieve valid user_email or user_password for job ${jobId}. Property may not have user_email or user_password assigned.`
        );
      }

      finalExpediaId = jobData.expediaId;
      finalUserEmail = jobData.user_email;
      finalUserPassword = jobData.user_password;
    }

    console.log(`Worker: Using expedia_id: ${finalExpediaId} for scraping`);

    // 3. Update job status to Running
    console.log(`Worker: Starting job ${jobId}...`);
    await jobService.startJob(jobId);

    // 4. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Worker: Starting property scraping job ${jobId}`, {
      jobId,
      expediaId: finalExpediaId,
      startDate,
      endDate,
    });

    // 5. Start scraping state manager
    scrapingStateManager.startScraping(
      finalExpediaId,
      jobId,
      startDate,
      endDate
    );

    try {
      // 6. Run the multi-platform scraping function for Expedia
      await mainMultiPlatform({
        platform: "expedia",
        propertyId: finalExpediaId,
        startDate,
        endDate,
        jobId,
        user_email: finalUserEmail,
        user_password: finalUserPassword,
      });

      // 7. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 8. Determine final status based on completion
      let finalStatus = JobStatus.Completed;
      if (progress.totalItems === 0) {
        finalStatus = JobStatus.Failed;
      } else if (progress.completionPercentage < 100) {
        finalStatus = JobStatus.Partial;
      }

      // 9. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus);

      // 10. Stop scraping state manager
      scrapingStateManager.stopScraping();

      // 11. Finalize logging
      await finalizeJobLogging("success");

      // Get log file information if available
      const logger = (global as any).getCurrentJobLogger?.();
      const logInfo = logger
        ? {
            logFilePath: logger.getLogFilePath(),
            logEntriesCount: logger.getLogEntriesCount(),
            note: "Log file uploaded to S3 and deleted locally after job completion",
          }
        : null;

      console.log(`Worker: Job ${jobId} completed successfully`);

      return {
        status: 200,
        message: `Property scraping ${finalStatus.toLowerCase()} successfully`,
        expediaId: finalExpediaId,
        jobId: jobId,
        progress: progress,
        finalStatus: finalStatus,
        logInfo: logInfo,
      };
    } catch (scrapingError) {
      // Mark job as failed on scraping error
      await dualLogError(`Worker: Job ${jobId} failed`, scrapingError, {
        jobId,
      });
      await progressManager.handleJobError(jobId, scrapingError);
      scrapingStateManager.stopScraping();

      // Update job status to Failed
      await jobService.updateJobStatus(jobId, JobStatus.Failed);

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw scrapingError;
    }
  }

  private async handleRerunFailed(jobData: WorkerJobData): Promise<any> {
    const { jobId, originalStatus } = jobData;

    if (!jobId) {
      throw new Error("jobId is required for rerun-failed jobs");
    }

    // 1. Validate job exists
    const validation = await jobService.validateJob(jobId);
    if (!validation.exists) {
      throw new Error(`Job with ID ${jobId} not found`);
    }

    // 2. Get job details
    const job = validation.job;
    if (!job) {
      throw new Error(`Job ${jobId} data not found`);
    }

    // 3. Get dates from job or use provided ones
    const startDate = jobData.startDate || "01/01/2024"; // fallback date
    const endDate = jobData.endDate || "12/31/2024"; // fallback date

    // 4. Get job data
    const jobDetails = await jobService.getExpediaIdFromJob(jobId);
    if (!jobDetails || !jobDetails.expediaId) {
      throw new Error(`Cannot retrieve valid expedia_id for job ${jobId}`);
    }

    if (!jobDetails.user_email || !jobDetails.user_password) {
      throw new Error(
        `Cannot retrieve valid user_email or user_password for job ${jobId}`
      );
    }

    const { expediaId, user_email, user_password } = jobDetails;

    console.log(
      `Worker: Rerunning failed/partial job ${jobId} with expedia_id: ${expediaId}`
    );

    // 5. Reset job status to Pending, then to Running
    console.log(
      `Worker: Resetting job ${jobId} status from ${originalStatus} to Pending...`
    );
    await jobService.updateJobStatus(jobId, JobStatus.Pending);

    console.log(`Worker: Starting job ${jobId}...`);
    await jobService.startJob(jobId);

    // 6. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Worker: Starting job rerun for ${jobId}`, {
      jobId,
      originalStatus,
      expediaId,
      startDate,
      endDate,
    });

    // 7. Start scraping state manager
    scrapingStateManager.startScraping(expediaId, jobId, startDate, endDate);

    try {
      // 8. Run the multi-platform scraping function for Expedia
      await mainMultiPlatform({
        platform: "expedia",
        propertyId: expediaId,
        startDate,
        endDate,
        jobId,
        user_email: user_email,
        user_password: user_password,
      });

      // 9. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 10. Determine final status based on completion
      let finalStatus = "Completed";
      if (progress.totalItems === 0) {
        finalStatus = "Failed";
      } else if (progress.completionPercentage < 100) {
        finalStatus = "Partial";
      }

      // 11. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus as any);

      // 12. Stop scraping state manager
      scrapingStateManager.stopScraping();

      // 13. Finalize logging
      await finalizeJobLogging("success");

      // Get log file information
      const logger = (global as any).getCurrentJobLogger?.();
      const logInfo = logger
        ? {
            logFilePath: logger.getLogFilePath(),
            logEntriesCount: logger.getLogEntriesCount(),
            note: "Log file uploaded to S3 and deleted locally after job completion",
          }
        : undefined;

      console.log(`Worker: Job ${jobId} rerun completed successfully`);

      return {
        status: 200,
        message: `${originalStatus} job rerun completed successfully`,
        jobId,
        originalStatus,
        finalStatus,
        progress,
        logInfo,
      };
    } catch (error) {
      console.error(`Worker: Error during job ${jobId} rerun:`, error);
      await dualLogError(`Worker: Job ${jobId} rerun failed`, error, { jobId });

      // Update job status to Failed
      await jobService.updateJobStatus(jobId, JobStatus.Failed);
      await progressManager.handleJobError(jobId, error);

      // Stop scraping state manager
      scrapingStateManager.stopScraping();

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw error;
    }
  }

  private async handleReservationRun(jobData: WorkerJobData): Promise<any> {
    const { reservations, jobId } = jobData;

    if (!reservations || reservations.length === 0) {
      throw new Error(
        "reservations array is required for reservation-run jobs"
      );
    }

    // Generate job ID if not provided
    const finalJobId = jobId || `reservation_job_${Date.now()}`;

    // Initialize job logging for reservation job
    initializeJobLogging(finalJobId);
    await dualLogInfo(
      `Worker: Starting reservation scraping job ${finalJobId}`,
      {
        jobId: finalJobId,
        reservationCount: reservations.length,
      }
    );

    scrapingStateManager.startScraping("reservations", finalJobId);

    try {
      await reservation(null, reservations);

      // Mark scraping as completed
      scrapingStateManager.stopScraping();

      // Finalize logging with success status
      await finalizeJobLogging("success");

      console.log(
        `Worker: Reservation job ${finalJobId} completed successfully`
      );

      return {
        status: 200,
        message: "Reservation search completed successfully",
        reservations: reservations,
        jobId: finalJobId,
      };
    } catch (reservationError) {
      await dualLogError(
        `Worker: Reservation job ${finalJobId} failed`,
        reservationError,
        {
          jobId: finalJobId,
        }
      );

      // Mark scraping as stopped on error
      scrapingStateManager.stopScraping();

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw reservationError;
    }
  }

  private async handleBookingRun(jobData: WorkerJobData): Promise<any> {
    const {
      jobId,
      portfolioId,
      propertyId,
      bookingId,
      user_email,
      user_password,
    } = jobData;

    if (!jobId) {
      throw new Error("jobId is required for booking-run jobs");
    }

    // 1. Validate job exists and can be run
    const validation = await jobService.validateJob(jobId);

    if (!validation.exists) {
      throw new Error(`Job with ID ${jobId} not found`);
    }

    if (!validation.canRun) {
      throw new Error(
        `Job ${jobId} is not in a runnable state. Current status: ${validation.job?.job_status}`
      );
    }

    // 2. Get booking_id and credentials from job's property if not provided
    let finalBookingId = bookingId;
    let finalUserEmail = user_email;
    let finalUserPassword = user_password;

    if (!finalBookingId || !finalUserEmail || !finalUserPassword) {
      await dualLogInfo(`Getting job data for booking job ${jobId}...`);
      const jobData = await jobService.getBookingIdFromJob(jobId);
      const bookingCredentials =
        await propertyCredentialsService.getBookingCredentialsFromJob(jobId);

      if (!jobData || !jobData.bookingId) {
        throw new Error(
          `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is 0.`
        );
      }

      if (
        !bookingCredentials?.bookingUsername ||
        !bookingCredentials?.bookingPassword
      ) {
        throw new Error(
          `Cannot retrieve valid booking credentials for job ${jobId}. Property may not have booking username or password assigned.`
        );
      }

      finalBookingId = jobData.bookingId;
      finalUserEmail = bookingCredentials.bookingUsername;
      finalUserPassword = bookingCredentials.bookingPassword;
    }

    await dualLogInfo(
      `Worker: Using booking_id: ${finalBookingId} for booking scraping`
    );

    // 3. Update job status to Running
    await dualLogInfo(`Worker: Starting booking job ${jobId}...`);
    await jobService.startJob(jobId);

    // 4. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Worker: Starting booking scraping job ${jobId}`, {
      jobId,
      portfolioId,
      propertyId,
      bookingId: finalBookingId,
    });

    // 5. Start scraping state manager
    scrapingStateManager.startScraping(finalBookingId.toString(), jobId);

    try {
      // 6. Run the multi-platform scraping function for Booking.com
      await mainMultiPlatform({
        platform: "booking",
        propertyId: finalBookingId.toString(),
        propertyIdForDb: propertyId,
        jobId,
        user_email: finalUserEmail,
        user_password: finalUserPassword,
      });

      // 7. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 8. Determine final status based on completion
      let finalStatus = JobStatus.Completed;
      if (progress.totalItems === 0) {
        finalStatus = JobStatus.Failed;
      } else if (progress.completionPercentage < 100) {
        finalStatus = JobStatus.Partial;
      }

      // 9. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus);

      // 10. Stop scraping state manager
      scrapingStateManager.stopScraping();

      // 11. Finalize logging
      await finalizeJobLogging("success");

      // Get log file information if available
      const logger = (global as any).getCurrentJobLogger?.();
      const logInfo = logger
        ? {
            logFilePath: logger.getLogFilePath(),
            logEntriesCount: logger.getLogEntriesCount(),
            note: "Log file uploaded to S3 and deleted locally after job completion",
          }
        : null;

      await dualLogInfo(`Worker: Booking job ${jobId} completed successfully`);

      await dualLogInfo("Booking scraping completed successfully", {
        jobId,
        portfolioId,
        propertyId,
        platform: "booking",
        finalStatus,
        progress,
      });

      return {
        status: 200,
        message: `Booking scraping ${finalStatus.toLowerCase()} successfully`,
        bookingId: finalBookingId,
        jobId: jobId,
        portfolioId: portfolioId,
        propertyId: propertyId,
        progress: progress,
        finalStatus: finalStatus,
        logInfo: logInfo,
        trackingStatus: finalStatus,
      };
    } catch (error) {
      // Mark job as failed on scraping error
      await dualLogError(`Worker: Booking job ${jobId} failed`, error, {
        jobId,
        portfolioId,
        propertyId,
        platform: "booking",
      });
      await progressManager.handleJobError(jobId, error);
      scrapingStateManager.stopScraping();

      // Update job status to Failed
      await jobService.updateJobStatus(jobId, JobStatus.Failed);

      // Get job details for notification
      let propertyName: string | undefined;
      try {
        const job = await jobService.getJobById(jobId);
        propertyName = job?.property_name;
      } catch (error) {
        await dualLogError(
          `Error fetching job details for notification: ${error}`
        );
      }

      // Send public notification for booking scraping job failure
      try {
        await notificationService.sendPublicNotification({
          title: "Booking.com Scraping Job Failed",
          message: `Booking.com scraping job failed for property ${
            propertyName || propertyId || "Unknown"
          }. Job ID: ${jobId}`,
          metadata: {
            jobId,
            propertyId,
            propertyName,
            portfolioId,
            bookingId: finalBookingId,
            error: error instanceof Error ? error.message : String(error),
            retryAttempt: jobService.retryAttempt,
            maxRetries: jobService.maxRetries,
            failedAt: new Date().toISOString(),
          },
        });
      } catch (notificationError) {
        await dualLogError(
          `Error sending booking job failure notification: ${notificationError}`
        );
      }

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      await jobService.setJobIdForRetryCheck(jobId);

      await dualLogError("Booking scraping job failed", error, {
        errorType: BookingErrorType.UNKNOWN,
        platform: "booking",
        propertyId,
        portfolioId,
        errorDescription: getBookingErrorDescription(BookingErrorType.UNKNOWN),
        retryAttempt: jobService.retryAttempt,
        maxRetries: jobService.maxRetries,
      });

      throw error;
    }
  }

  private async handleBookingRerunFailed(jobData: WorkerJobData): Promise<any> {
    const { jobId, originalStatus, portfolioId, propertyId } = jobData;

    if (!jobId) {
      await dualLogError(
        "Booking rerun failed - missing jobId",
        new Error("jobId is required for booking-rerun-failed jobs"),
        {
          errorType: BookingErrorType.RERUN_INVALID_STATUS,
          platform: "booking",
          originalStatus,
          errorDescription: getBookingErrorDescription(
            BookingErrorType.RERUN_INVALID_STATUS
          ),
        }
      );
      throw new Error("jobId is required for booking-rerun-failed jobs");
    }

    await jobService.setJobIdForRetryCheck(jobId);

    await dualLogInfo(`Starting booking job rerun`, {
      jobId,
      originalStatus,
      portfolioId,
      propertyId,
      platform: "booking",
      rerunReason: "Manual rerun of failed job",
      retryAttempt: jobService.retryAttempt,
      maxRetries: jobService.maxRetries,
    });

    // 1. Reset job status from Failed to Pending
    await dualLogInfo(`Resetting job status for rerun`, {
      jobId,
      fromStatus: originalStatus,
      toStatus: JobStatus.Pending,
      platform: "booking",
    });

    await jobService.updateJobStatus(jobId, JobStatus.Pending);

    // 2. Initialize job logging for tracking
    initializeJobLogging(jobId);

    await dualLogInfo(`Booking job rerun initialized`, {
      jobId,
      originalStatus,
      portfolioId,
      propertyId,
      platform: "booking",
      rerunAttempt: 1,
    });

    try {
      // 3. Execute the same logic as handleBookingRun
      // This ensures consistent behavior between new jobs and rerun jobs
      const result = await this.handleBookingRun(jobData);

      // 4. Log successful rerun completion
      await dualLogInfo(`Booking job rerun completed successfully`, {
        jobId,
        originalStatus,
        portfolioId,
        propertyId,
        platform: "booking",
        finalStatus: result.trackingStatus,
        rerunSuccess: true,
        retryAttempt: jobService.retryAttempt,
        maxRetries: jobService.maxRetries,
      });

      // 5. Update the response to indicate this was a rerun
      return {
        ...result,
        message: `${originalStatus} booking job rerun completed successfully`,
        originalStatus,
        isRerun: true,
        rerunSuccess: true,
        rerunAttempt: 1,
      };
    } catch (error) {
      await dualLogError("Booking job rerun failed", error, {
        errorType: BookingErrorType.RERUN_FAILED,
        platform: "booking",
        originalStatus,
        jobId,
        portfolioId,
        propertyId,
        errorDescription: getBookingErrorDescription(
          BookingErrorType.RERUN_FAILED
        ),
        retryAttempt: jobService.retryAttempt,
        maxRetries: jobService.maxRetries,
      });

      await dualLogInfo(`Booking job rerun failure details`, {
        jobId,
        originalStatus,
        platform: "booking",
        errorMessage: error instanceof Error ? error.message : String(error),
        failurePhase: "rerun_execution",
        shouldRetry: shouldRetryBookingError(BookingErrorType.RERUN_FAILED),
        retryAttempt: jobService.retryAttempt,
        maxRetries: jobService.maxRetries,
      });

      // Update job status to Failed
      await jobService.failJob(jobId);

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw error;
    }
  }

  private async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    console.log("Worker: Shutting down...");

    try {
      // Stop any current scraping
      scrapingStateManager.stopScraping();

      // Close database connection
      await mongoose.disconnect();
      console.log("Worker: Disconnected from MongoDB");

      // Exit gracefully
      process.exit(0);
    } catch (error) {
      console.error("Worker: Error during shutdown:", error);
      process.exit(1);
    }
  }
}

// Initialize the worker
try {
  new ScrapingWorker();
} catch (error) {
  console.error("Worker: Failed to initialize:", error);
  process.exit(1);
}
