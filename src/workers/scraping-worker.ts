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
  isAuditSmsConfigured,
  sendAuditReadySms,
} from "../common/audit-ready-sms.js";
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
import {
  getGoogleDriveJobItemsConfigurationIssue,
  uploadBookingJobItemsXlsxToGoogleDrive,
} from "../common/google-drive-job-items.js";
import { jobItemsBookingVccToXlsxBuffer } from "../common/job-items-booking-vcc-xlsx.js";
import { mainMultiPlatform } from "../main-multi-platform.js";
import {
  JobStatus,
  OTAProvider,
  resolveJobOtaProvider,
} from "../models/job.model.js";
import reservation from "../reservation/reservation.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobService } from "../services/job.service.js";
import {
  getFailedReasonForUser,
  isStatusAlreadySaved,
  markStatusSaved,
} from "../common/failed-reason.js";
import {
  pickRandomPhoneForJob,
  setJobContact,
  clearJobPhone,
  getJobPhone,
  getJobPhoneAndPort,
  getJobPort,
} from "../common/job-phone-store.js";
import { notificationService } from "../services/notification.service.js";

/**
 * `maybeUploadBookingJobItemsToDrive` runs only on Booking worker paths. Uses
 * `resolveJobOtaProvider` (`ota_provider` or legacy BSON `OTA`). Treat missing as Booking
 * for this path; block only when clearly another OTA.
 */
function isJobEligibleForBookingDriveExport(ota: unknown): boolean {
  if (ota === null || ota === undefined) return true;
  if (typeof ota !== "string") {
    return ota === OTAProvider.Booking;
  }
  const t = ota.trim();
  if (t === "") return true;
  if (t === OTAProvider.Booking) return true;
  if (t.toLowerCase() === "booking") return true;
  if (t === OTAProvider.Expedia || t === OTAProvider.Agoda) return false;
  return false;
}

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

  /**
   * **Booking-only (this branch).** When a Booking job is `Completed` or `Partial` in MongoDB,
   * export `job_items` to XLSX and upload under Drive `root/Booking/DD-MM-YYYY`. Expedia / Agoda /
   * other job types do not use this path — `handleBookingRun`, `handleBookingRunGroup` (finally),
   * and booking reruns call it. Skips if Drive env is missing, resolved OTA is clearly non-Booking,
   * status not Completed/Partial, or no items. Legacy jobs may only have BSON field `OTA`.
   */
  private async maybeUploadBookingJobItemsToDrive(jobId: string): Promise<void> {
    const configIssue = getGoogleDriveJobItemsConfigurationIssue();
    if (configIssue) {
      await dualLogInfo(
        `Google Drive: Booking upload skipped — ${configIssue}`,
        { jobId }
      );
      return;
    }
    try {
      const job = await jobService.getJobById(jobId);
      if (!job) {
        await dualLogInfo(
          `Google Drive: Booking upload skipped — job not found`,
          { jobId }
        );
        return;
      }
      const effectiveOta = resolveJobOtaProvider(job);
      if (!isJobEligibleForBookingDriveExport(effectiveOta)) {
        await dualLogInfo(
          `Google Drive: Booking upload skipped — resolved OTA is "${String(effectiveOta)}" (ota_provider="${String(job.ota_provider)}"), expected Booking`,
          { jobId }
        );
        return;
      }
      const uploadable =
        job.job_status === JobStatus.Completed ||
        job.job_status === JobStatus.Partial;
      if (!uploadable) {
        await dualLogInfo(
          `Google Drive: Booking upload skipped — job_status is "${String(job.job_status)}", expected Completed or Partial`,
          { jobId }
        );
        return;
      }

      const items = await jobService.getJobItems(jobId);
      if (items.length === 0) {
        await dualLogInfo(
          `Google Drive: skip Booking upload (no items) for ${jobId}`,
          { jobId }
        );
        return;
      }

      const property = await jobService.getPropertyForJob(jobId);
      const buffer = jobItemsBookingVccToXlsxBuffer(items, job, property);
      const url = await uploadBookingJobItemsXlsxToGoogleDrive(buffer, {
        portfolioName: job.portfolio_name ?? "",
        propertyName: job.property_name ?? "",
      });
      if (url) {
        await jobService.updateJobItemsFileLink(jobId, url);
        await dualLogInfo(`Google Drive: Booking job items XLSX uploaded`, {
          jobId,
          url,
        });
      }
    } catch (err) {
      await dualLogError(
        `Google Drive: Booking job items upload failed for ${jobId}`,
        err,
        { jobId }
      );
    }
  }

  /**
   * After Completed: send audit-ready SMS to `job.phone_number_for_report`.
   * Failures are logged only; they do not fail the job.
   */
  private async maybeSendAuditReadySms(
    jobId: string,
    finalStatus: JobStatus | string
  ): Promise<void> {
    const isCompleted =
      finalStatus === JobStatus.Completed || finalStatus === "Completed";
    if (!isCompleted) return;

    if (!isAuditSmsConfigured()) {
      await dualLogInfo(
        `Audit SMS: skip (neither Ejoin nor Twilio + DEMO_WEBSITE_URL configured) for ${jobId}`,
        { jobId }
      );
      return;
    }

    try {
      const job = await jobService.getJobById(jobId);
      if (!job) {
        await dualLogInfo(`Audit SMS: skip, job not found ${jobId}`, {
          jobId,
        });
        return;
      }
      const phone = job.phone_number_for_report?.trim();
      if (!phone) {
        await dualLogInfo(
          `Audit SMS: skip (no phone_number_for_report on job) for ${jobId}`,
          { jobId }
        );
        return;
      }
      await sendAuditReadySms(phone, jobId);
      await dualLogInfo(`Audit SMS: audit-ready message sent`, { jobId });
    } catch (err) {
      await dualLogError(`Audit SMS: audit-ready send failed for ${jobId}`, err, {
        jobId,
      });
    }
  }

  /** Distinct value per pool worker thread for `job.worker_assigned` when Running. */
  private workerPoolAssignmentTag(jobData: WorkerJobData): string {
    const base = process.env.WORKER_ID || "scraper-worker";
    const pool = jobData.assignedWorkerPoolId;
    return pool ? `${base}:${pool}` : base;
  }

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

    // Lock phone/port for this job: use round-robin assignment from main thread, or pick random
    if (jobData.selectedContact) {
      setJobContact(jobData.jobId, jobData.selectedContact);
      if (
        jobData.jobType === JobType.BookingRunGroup &&
        Array.isArray(jobData.bookingGroup)
      ) {
        for (const step of jobData.bookingGroup) {
          if (step?.jobId) {
            setJobContact(step.jobId, jobData.selectedContact);
          }
        }
      }
    } else {
      pickRandomPhoneForJob(jobData.jobId);
      if (
        jobData.jobType === JobType.BookingRunGroup &&
        Array.isArray(jobData.bookingGroup)
      ) {
        const locked = getJobPhoneAndPort(jobData.jobId);
        if (locked?.phone) {
          for (const step of jobData.bookingGroup) {
            if (step?.jobId) {
              setJobContact(step.jobId, {
                phone: locked.phone,
                port: locked.port,
              });
            }
          }
        }
      }
    }
    const lockedPhone = jobData.selectedContact?.phone ?? getJobPhone(jobData.jobId) ?? "";
    const lastThree = lockedPhone.replace(/\D/g, "").slice(-3);
    const port = getJobPort(jobData.jobId);
    await dualLogInfo(
      port
        ? `Job ${jobData.jobId} locked contact ...${lastThree} port ${port}`
        : `Job ${jobData.jobId} locked contact ending ...${lastThree}`
    );

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

        case JobType.BookingRunGroup:
          result = await this.handleBookingRunGroup(jobData);
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
      clearJobPhone(jobData.jobId);
      if (
        jobData.jobType === JobType.BookingRunGroup &&
        Array.isArray(jobData.bookingGroup)
      ) {
        for (const step of jobData.bookingGroup) {
          if (step?.jobId) {
            clearJobPhone(step.jobId);
          }
        }
      }
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
    await jobService.startJob(jobId, this.workerPoolAssignmentTag(jobData));

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
    await jobService.startJob(jobId, this.workerPoolAssignmentTag(jobData));

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

    // 2. Resolve booking_id and credentials. DB is source of truth for password (and username when
    //    stored) so runs stay correct after Booking.com password updates; request body may be stale.
    let finalBookingId = bookingId;
    const bookingCredentials =
      await propertyCredentialsService.getBookingCredentialsFromJob(jobId);

    if (!finalBookingId) {
      await dualLogInfo(`Getting booking_id for job ${jobId}...`);
      const jobBookingData = await jobService.getBookingIdFromJob(jobId);
      if (!jobBookingData?.bookingId) {
        throw new Error(
          `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is 0.`
        );
      }
      finalBookingId = jobBookingData.bookingId;
    }

    const finalUserEmail =
      bookingCredentials?.bookingUsername ?? user_email ?? undefined;
    const finalUserPassword =
      bookingCredentials?.bookingPassword ?? user_password ?? undefined;

    if (!finalUserEmail || !finalUserPassword) {
      throw new Error(
        `Cannot retrieve valid booking credentials for job ${jobId}. Property may not have booking username/password and none were provided on the job.`
      );
    }

    if (bookingCredentials?.bookingPassword) {
      await dualLogInfo(
        `Worker: Using booking credentials from database for job ${jobId} (password always from DB when present)`
      );
    }

    await dualLogInfo(
      `Worker: Using booking_id: ${finalBookingId} for booking scraping`
    );

    // 3. Update job status to Running
    await dualLogInfo(`Worker: Starting booking job ${jobId}...`);
    await jobService.startJob(jobId, this.workerPoolAssignmentTag(jobData));

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

      // 9. Update final job status (with failed_reason if no reservations found)
      if (finalStatus === JobStatus.Failed) {
        await jobService.updateJobStatusWithReason(
          jobId,
          JobStatus.Failed,
          "No reservations found for the specified date range."
        );
      } else {
        await jobService.updateJobStatus(jobId, finalStatus);
      }

      await this.maybeSendAuditReadySms(jobId, finalStatus);

      // Booking-only: Drive XLSX (after status is persisted), whether scrape used single or multi platform inside mainMultiPlatform
      await this.maybeUploadBookingJobItemsToDrive(jobId);

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
    } catch (error: any) {
      // Mark job as failed on scraping error
      await dualLogError(`Worker: Booking job ${jobId} failed`, error, {
        jobId,
        portfolioId,
        propertyId,
        platform: "booking",
      });
      await progressManager.handleJobError(jobId, error);
      scrapingStateManager.stopScraping();

      // Update job status to Failed, preserving any specific failed_reason
      if (!isStatusAlreadySaved(error)) {
        const failedReason =
          getFailedReasonForUser(error) ||
          "An unexpected error occurred. Please try again.";
        await jobService.failJobSafe(jobId, failedReason);
        markStatusSaved(error);
      }

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

  private async handleBookingRunGroup(jobData: WorkerJobData): Promise<any> {
    const bookingGroup = jobData.bookingGroup as Array<{
      jobId: string;
      portfolioId?: string;
      propertyId?: string;
      bookingId: number;
    }>;
    const leaseJobId = jobData.jobId;
    const { user_email, user_password } = jobData;

    if (!bookingGroup?.length) {
      throw new Error("bookingGroup is required for booking-run-group");
    }
    if (!leaseJobId) {
      throw new Error("jobId (lease) is required for booking-run-group");
    }

    if (!user_email || !user_password) {
      throw new Error(
        "user_email and user_password are required for booking-run-group (fallback if DB incomplete)"
      );
    }

    for (const step of bookingGroup) {
      const validation = await jobService.validateJob(step.jobId);
      if (!validation.exists) {
        throw new Error(`Job with ID ${step.jobId} not found`);
      }
      if (!validation.canRun) {
        throw new Error(
          `Job ${step.jobId} is not in a runnable state. Current status: ${validation.job?.job_status}`
        );
      }
    }

    await dualLogInfo(
      `Worker: booking-run-group lease ${leaseJobId}, ${bookingGroup.length} property job(s) (one login)`
    );

    scrapingStateManager.startScraping(
      String(bookingGroup[0].bookingId),
      leaseJobId
    );

    try {
      await mainMultiPlatform({
        platform: "booking",
        jobId: leaseJobId,
        groupOtpLeaseJobId: leaseJobId,
        user_email,
        user_password,
        bookingGroupSteps: bookingGroup.map((s) => ({
          jobId: s.jobId,
          portfolioId: s.portfolioId,
          propertyIdForDb: s.propertyId,
          bookingId: String(s.bookingId),
        })),
        propertyId: String(bookingGroup[0].bookingId),
        propertyIdForDb: bookingGroup[0].propertyId,
        workerAssignmentTag: this.workerPoolAssignmentTag(jobData),
      });

      for (const step of bookingGroup) {
        const job = await jobService.getJobById(step.jobId);
        if (job?.job_status) {
          await this.maybeSendAuditReadySms(step.jobId, job.job_status);
        }
      }

      return {
        status: 200,
        message: "Booking group scraping completed",
        jobId: leaseJobId,
        groupSize: bookingGroup.length,
        finalStatus: JobStatus.Completed,
        trackingStatus: JobStatus.Completed,
      };
    } catch (error: any) {
      await progressManager.handleJobError(leaseJobId, error).catch(() => {});
      throw error;
    } finally {
      // Bulk / booking-run-group: upload for every property job even if the group throws after
      // some steps (earlier jobs may already be Completed or Partial in MongoDB).
      for (const step of bookingGroup) {
        await this.maybeUploadBookingJobItemsToDrive(step.jobId);
      }
      if (scrapingStateManager.isRunning()) {
        scrapingStateManager.stopScraping();
      }
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
    } catch (error: any) {
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

      // Update job status to Failed, preserving any specific failed_reason
      if (!isStatusAlreadySaved(error)) {
        const failedReason =
          getFailedReasonForUser(error) ||
          "An unexpected error occurred. Please try again.";
        await jobService.failJobSafe(jobId, failedReason);
        markStatusSaved(error);
      }

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
