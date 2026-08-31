import dotenv from "dotenv";
import mongoose from "mongoose";
import { parentPort } from "worker_threads";
import { otpCompletionNotifier } from "../common/otp-completion-notifier.js";
import { WorkerJobData, WorkerMessage } from "../common/worker-types.js";

// Import the main functions
import agoda from "../agoda.js";
import { runAgodaReopenCase } from "../agoda/reopen-case/reopen-case.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
} from "../common/log-helper.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import graphqlScraping from "../expedia-graphql.js";
import main from "../main.js";
import { CaseStatus, JobStatus } from "../models/job.model.js";
import reservation from "../reservation/reservation.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobService } from "../services/job.service.js";
import { updateHistoricalRunDate } from "../services/recurring-jobs.service.js";
import {
  getFailedReasonForUser,
  isStatusAlreadySaved,
  markStatusSaved,
} from "../common/failed-reason.js";
import { jobItemsAgodaToXlsxBuffer } from "../common/job-items-agoda-xlsx.js";
import {
  getGoogleDriveJobItemsConfigurationIssue,
  uploadAgodaJobItemsXlsxToGoogleDrive,
} from "../common/google-drive-job-items.js";

// Load environment variables
dotenv.config();

class ScrapingWorker {
  private currentJobId?: string;
  private isShuttingDown = false;

  constructor() {
    this.setupEventHandlers();
    this.setupOtpCompletionListener();
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
            type: "job-progress",
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
          type: "job-error",
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

  private setupOtpCompletionListener(): void {
    // Listen for OTP completion notifications
    otpCompletionNotifier.onOtpCompleted((jobId: string) => {
      // Only send notification if this worker is handling the job
      if (this.currentJobId === jobId) {
        console.log(
          `Worker received OTP completion notification for job ${jobId}`
        );
        this.sendMessage({
          type: "job-progress",
          jobId: jobId,
          data: {
            otpCompleted: true,
            message: "OTP verification completed, releasing OTP for other jobs",
            timestamp: new Date(),
          },
          timestamp: new Date(),
        });
      }
    });
  }

  private sendMessage(message: WorkerMessage): void {
    if (parentPort && !this.isShuttingDown) {
      parentPort.postMessage(message);
    }
  }

  private isCompletedStatus(finalStatus: JobStatus | string): boolean {
    return (
      finalStatus === JobStatus.Completed || finalStatus === "Completed"
    );
  }

  /**
   * After Completed: notify DBMS to update the recurring job's historical run date.
   * Failures are logged only; they do not fail the job.
   */
  private async maybeUpdateHistoricalRunDateOnCompletion(
    jobId: string,
    finalStatus: JobStatus | string,
    options?: { startDate?: string; endDate?: string }
  ): Promise<void> {
    if (!this.isCompletedStatus(finalStatus)) return;
    try {
      await updateHistoricalRunDate(jobId, options);
    } catch (err) {
      await dualLogError(
        `update-historical-run-date: apply failed for ${jobId}`,
        err,
        { jobId }
      );
    }
  }

  /**
   * After Agoda job is Completed or Partial: export `job_items` to XLSX under Drive
   * `root/Agoda/DD-MM-YYYY` (same filename replaces). Only runs from Agoda worker paths.
   */
  private async maybeUploadAgodaJobItemsToDrive(jobId: string): Promise<void> {
    const issue = getGoogleDriveJobItemsConfigurationIssue();
    if (issue) {
      await dualLogInfo(`Google Drive: Agoda upload skipped — ${issue}`, {
        jobId,
      });
      return;
    }
    try {
      const job = await jobService.getJobById(jobId);
      if (!job) {
        await dualLogInfo(
          `Google Drive: Agoda upload skipped — job not found`,
          { jobId }
        );
        return;
      }
      const status = job.job_status;
      if (status !== JobStatus.Completed && status !== JobStatus.Partial) {
        await dualLogInfo(
          `Google Drive: Agoda upload skipped — job_status is "${String(status)}", expected Completed or Partial`,
          { jobId }
        );
        return;
      }
      const items = await jobService.getJobItems(jobId);
      if (items.length === 0) {
        await dualLogInfo(
          `Google Drive: skip Agoda upload (no items) for ${jobId}`,
          { jobId }
        );
        return;
      }
      const property = await jobService.getPropertyForJob(jobId);
      const buffer = jobItemsAgodaToXlsxBuffer(items, job, property);
      const url = await uploadAgodaJobItemsXlsxToGoogleDrive(buffer, {
        portfolioName: job.portfolio_name ?? "",
        propertyName: job.property_name ?? "",
      });
      if (url) {
        await jobService.updateJobItemsFileLink(jobId, url);
        await dualLogInfo(`Google Drive: Agoda job items XLSX uploaded`, {
          jobId,
          url,
        });
      }
    } catch (err) {
      await dualLogError(
        `Google Drive: Agoda job items upload failed for ${jobId}`,
        err,
        { jobId }
      );
    }
  }

  private async executeJob(jobData: WorkerJobData): Promise<void> {
    this.currentJobId = jobData.jobId;

    // Debug: Log received job data
    console.log(
      `Worker received job data for ${jobData.jobId}:`,
      JSON.stringify(jobData, null, 2)
    );
    console.log(
      `Worker job type: '${jobData.jobType}' (type: ${typeof jobData.jobType})`
    );

    this.sendMessage({
      type: "job-start",
      jobId: jobData.jobId,
      data: { jobType: jobData.jobType, startTime: new Date() },
      timestamp: new Date(),
    });

    try {
      let result;

      switch (jobData.jobType) {
        case "property-run":
          result = await this.handlePropertyRun(jobData);
          break;

        case "rerun-failed":
          result = await this.handleRerunFailed(jobData);
          break;

        case "reservation-run":
          result = await this.handleReservationRun(jobData);
          break;

        case "graphql-run":
          result = await this.handleGraphqlRun(jobData);
          break;

        case "agoda-property-run":
          result = await this.handleAgodaPropertyRun(jobData);
          break;

        case "agoda-rerun-failed":
          result = await this.handleAgodaRerunFailed(jobData);
          break;

        case "agoda-reopen-case":
          result = await this.handleAgodaReopenCase(jobData);
          break;

        case "stop":
          break;

        default:
          throw new Error(`Unknown job type: ${jobData.jobType}`);
      }

      this.sendMessage({
        type: "job-complete",
        jobId: jobData.jobId,
        data: result,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`Worker job ${jobData.jobId} failed:`, error);

      this.sendMessage({
        type: "job-error",
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
          `Cannot retrieve valid Expedia credentials for job ${jobId}. Property may not have credentials assigned.`
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
      // 6. Run the main scraping function
      await main(
        finalExpediaId,
        startDate,
        endDate,
        jobId,
        finalUserEmail,
        finalUserPassword
      );

      // 7. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 8. Determine final status based on completion
      let finalStatus = "Completed";
      if (progress.totalItems === 0) {
        finalStatus = "Failed";
      } else if (progress.completionPercentage < 100) {
        finalStatus = "Partial";
      }

      // 9. Update final job status only if job is still Running (never overwrite Failed/Stopped with Completed)
      const currentJobExpedia = await jobService.getJobById(jobId);
      const alreadyTerminalExpedia =
        currentJobExpedia?.job_status === JobStatus.Failed ||
        currentJobExpedia?.job_status === JobStatus.Stopped;
      if (alreadyTerminalExpedia) {
        await dualLogInfo(
          `Worker: Skipping status update to ${finalStatus}; job ${jobId} is already ${currentJobExpedia?.job_status}`,
          { jobId, currentStatus: currentJobExpedia?.job_status }
        );
      } else {
        await jobService.updateJobStatus(jobId, finalStatus as any);
      }

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

      console.log(`Worker: ✅ Job ${jobId} completed successfully`);

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
        `Cannot retrieve valid Expedia credentials for job ${jobId}`
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
    await jobService.updateJobStatus(jobId, "Pending" as any);

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
      // 8. Run the main scraping function
      await main(
        expediaId,
        startDate,
        endDate,
        jobId,
        user_email,
        user_password
      );

      // 9. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 10. Determine final status based on completion
      let finalStatus = "Completed";
      if (progress.totalItems === 0) {
        finalStatus = "Failed";
      } else if (progress.completionPercentage < 100) {
        finalStatus = "Partial";
      }

      // 11. Update final job status only if job is still Running (never overwrite Failed/Stopped with Completed)
      const currentJobRerunExpedia = await jobService.getJobById(jobId);
      const alreadyTerminalRerunExpedia =
        currentJobRerunExpedia?.job_status === JobStatus.Failed ||
        currentJobRerunExpedia?.job_status === JobStatus.Stopped;
      if (alreadyTerminalRerunExpedia) {
        await dualLogInfo(
          `Worker: Skipping status update to ${finalStatus}; job ${jobId} is already ${currentJobRerunExpedia?.job_status}`,
          { jobId, currentStatus: currentJobRerunExpedia?.job_status }
        );
      } else {
        await jobService.updateJobStatus(jobId, finalStatus as any);
      }

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

      console.log(`Worker: ✅ Job ${jobId} rerun completed successfully`);

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
      console.error(`Worker: ❌ Error during job ${jobId} rerun:`, error);
      await dualLogError(`Worker: Job ${jobId} rerun failed`, error, { jobId });

      // Update job status to Failed
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
        `Worker: ✅ Reservation job ${finalJobId} completed successfully`
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

  private async handleGraphqlRun(jobData: WorkerJobData): Promise<any> {
    const { jobId, startDate, endDate, expediaId, user_email, user_password } =
      jobData;

    if (!startDate || !endDate || !jobId) {
      throw new Error(
        "startDate, endDate, and jobId are required for graphql-run jobs"
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
      console.log(`Getting job data for GraphQL job ${jobId}...`);
      const jobData = await jobService.getExpediaIdFromJob(jobId);

      if (!jobData || !jobData.expediaId) {
        throw new Error(
          `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`
        );
      }

      if (!jobData.user_email || !jobData.user_password) {
        throw new Error(
          `Cannot retrieve valid Expedia credentials for job ${jobId}. Property may not have credentials assigned.`
        );
      }

      finalExpediaId = jobData.expediaId;
      finalUserEmail = jobData.user_email;
      finalUserPassword = jobData.user_password;
    }

    console.log(
      `Worker: Using expedia_id: ${finalExpediaId} for GraphQL scraping`
    );

    // 3. Update job status to Running
    console.log(`Worker: Starting GraphQL job ${jobId}...`);
    await jobService.startJob(jobId);

    // 4. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(
      `Worker: Starting GraphQL property scraping job ${jobId}`,
      {
        jobId,
        expediaId: finalExpediaId,
        startDate,
        endDate,
      }
    );

    // 5. Start scraping state manager
    scrapingStateManager.startScraping(
      finalExpediaId,
      jobId,
      startDate,
      endDate
    );

    try {
      // 6. Run the GraphQL scraping function
      await graphqlScraping(
        finalExpediaId,
        startDate,
        endDate,
        jobId,
        finalUserEmail,
        finalUserPassword
      );

      // 7. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 8. Determine final status based on completion
      let finalStatus = "Completed";
      if (progress.totalItems === 0) {
        finalStatus = "Failed";
      } else if (progress.completionPercentage < 100) {
        finalStatus = "Partial";
      }

      // 9. Update final job status only if job is still Running (never overwrite Failed/Stopped with Completed)
      const currentJobGraphQL = await jobService.getJobById(jobId);
      const alreadyTerminalGraphQL =
        currentJobGraphQL?.job_status === JobStatus.Failed ||
        currentJobGraphQL?.job_status === JobStatus.Stopped;
      if (alreadyTerminalGraphQL) {
        await dualLogInfo(
          `Worker: Skipping status update to ${finalStatus}; job ${jobId} is already ${currentJobGraphQL?.job_status}`,
          { jobId, currentStatus: currentJobGraphQL?.job_status }
        );
      } else {
        await jobService.updateJobStatus(jobId, finalStatus as any);
      }

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

      console.log(`Worker: ✅ GraphQL job ${jobId} completed successfully`);

      return {
        status: 200,
        message: `GraphQL property scraping ${finalStatus.toLowerCase()} successfully`,
        expediaId: finalExpediaId,
        jobId: jobId,
        progress: progress,
        finalStatus: finalStatus,
        logInfo: logInfo,
      };
    } catch (scrapingError) {
      // Mark job as failed on scraping error
      await dualLogError(`Worker: GraphQL job ${jobId} failed`, scrapingError, {
        jobId,
      });
      await progressManager.handleJobError(jobId, scrapingError);
      scrapingStateManager.stopScraping();

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw scrapingError;
    }
  }

  private async handleAgodaPropertyRun(jobData: WorkerJobData): Promise<any> {
    const {
      jobId,
      startDate,
      endDate,
      agodaId,
      agodaUsername,
      agodaPassword,
      brightDataSessionId,
      windowSize,
      timezone,
      acceptLanguage,
    } = jobData;

    if (!startDate || !endDate || !jobId) {
      throw new Error(
        "startDate, endDate, and jobId are required for agoda-property-run jobs"
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

    // 2. Get agoda_id from job's property if not provided
    let finalAgodaId = agodaId;
    let finalAgodaUsername = agodaUsername;
    let finalAgodaPassword = agodaPassword;

    if (!finalAgodaId || !finalAgodaUsername || !finalAgodaPassword) {
      console.log(`Getting job data for job ${jobId}...`);

      // Get Agoda ID from job
      const propertyData = await jobService.getAgodaIdFromJob(jobId);

      // Get Agoda credentials
      const propertyCredentials =
        await propertyCredentialsService.getCredentialsByJobId(jobId);

      if (!propertyData || !propertyData.agodaId) {
        throw new Error(
          `Cannot retrieve valid agoda_id for job ${jobId}. Property may not have agoda_id assigned or agoda_id is "0".`
        );
      }

      if (
        !propertyCredentials?.agodaUsername ||
        !propertyCredentials?.agodaPassword
      ) {
        throw new Error(
          `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}. Property may not have agodaUsername or agodaPassword assigned.`
        );
      }

      finalAgodaId = propertyData.agodaId;
      finalAgodaUsername = propertyCredentials.agodaUsername;
      finalAgodaPassword = propertyCredentials.agodaPassword;
    }

    console.log(`Worker: Using agoda_id: ${finalAgodaId} for scraping`);

    // 3. Update job status to Running
    console.log(`Worker: Starting job ${jobId}...`);
    await jobService.startJob(jobId);

    // 4. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Worker: Starting Agoda property scraping job ${jobId}`, {
      jobId,
      agodaId: finalAgodaId,
      startDate,
      endDate,
      brightDataSessionId,
      windowSize,
      timezone,
      acceptLanguage,
    });

    // 5. Start scraping state manager
    scrapingStateManager.startScraping(finalAgodaId, jobId, startDate, endDate);

    try {
      // 6. Run the main Agoda scraping function with Bright Data isolation
      await agoda(
        finalAgodaId,
        startDate,
        endDate,
        jobId,
        finalAgodaUsername,
        finalAgodaPassword,
        brightDataSessionId,
        windowSize,
        timezone,
        acceptLanguage
      );

      // 7. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 8. Determine final status based on completion
      let finalStatus = JobStatus.Completed;
      if (progress.totalItems === 0) {
        finalStatus = JobStatus.Failed;
      } else if (progress.completionPercentage < 100) {
        finalStatus = JobStatus.Partial;
      }

      // 9. Update final job status only if job is still Running (never overwrite Failed/Stopped with Completed)
      const currentJob = await jobService.getJobById(jobId);
      const alreadyTerminal =
        currentJob?.job_status === JobStatus.Failed ||
        currentJob?.job_status === JobStatus.Stopped;
      if (alreadyTerminal) {
        await dualLogInfo(
          `Worker: Skipping status update to ${finalStatus}; job ${jobId} is already ${currentJob?.job_status}`,
          { jobId, currentStatus: currentJob?.job_status }
        );
      } else {
        await jobService.updateJobStatus(jobId, finalStatus);
      }

      if (
        finalStatus === JobStatus.Completed ||
        finalStatus === JobStatus.Partial
      ) {
        await this.maybeUploadAgodaJobItemsToDrive(jobId);
      }

      await this.maybeUpdateHistoricalRunDateOnCompletion(jobId, finalStatus, {
        startDate,
        endDate,
      });

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

      console.log(`Worker: ✅ Agoda job ${jobId} completed successfully`);

      return {
        status: 200,
        message: `Agoda property scraping ${finalStatus.toLowerCase()} successfully`,
        agodaId: finalAgodaId,
        jobId: jobId,
        progress: progress,
        finalStatus: finalStatus,
        logInfo: logInfo,
      };
    } catch (scrapingError: any) {
      // Mark job as failed on scraping error
      await dualLogError(`Worker: Agoda job ${jobId} failed`, scrapingError, {
        jobId,
      });
      await progressManager.handleJobError(jobId, scrapingError);
      scrapingStateManager.stopScraping();

      if (!isStatusAlreadySaved(scrapingError)) {
        const failedReason =
          getFailedReasonForUser(scrapingError) ||
          "An unexpected error occurred. Please try again.";
        await jobService.failJobSafe(jobId, failedReason);
        markStatusSaved(scrapingError);
      }

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw scrapingError;
    }
  }

  /**
   * Reopen run: no date range and no booking data — it just logs in, opens the
   * property page and files a Need Help request for the bookings the Partner
   * Support report flagged.
   */
  private async handleAgodaReopenCase(jobData: WorkerJobData): Promise<any> {
    const {
      jobId,
      agodaId,
      agodaUsername,
      agodaPassword,
      reopenBookingIds,
      caseId,
      brightDataSessionId,
      windowSize,
      timezone,
      acceptLanguage,
    } = jobData;

    if (!jobId) {
      throw new Error("jobId is required for agoda-reopen-case jobs");
    }

    // Anything that goes wrong from here on is a failed reopen attempt, so it
    // has to land on case_status too — not just the browser run below.
    let resolved: {
      agodaId: string;
      agodaUsername: string;
      agodaPassword: string;
      bookingIds: string[];
    };

    try {
      if (!reopenBookingIds || reopenBookingIds.length === 0) {
        throw new Error(
          "reopenBookingIds is required and must not be empty for agoda-reopen-case jobs"
        );
      }

      // The job has usually already run to completion, so `canRun` is not
      // checked here — only that the job still exists.
      const validation = await jobService.validateJob(jobId);
      if (!validation.exists) {
        throw new Error(`Job with ID ${jobId} not found`);
      }

      let finalAgodaId = agodaId;
      let finalAgodaUsername = agodaUsername;
      let finalAgodaPassword = agodaPassword;

      if (!finalAgodaId || !finalAgodaUsername || !finalAgodaPassword) {
        const propertyData = await jobService.getAgodaIdFromJob(jobId);
        const propertyCredentials =
          await propertyCredentialsService.getCredentialsByJobId(jobId);

        if (!propertyData || !propertyData.agodaId) {
          throw new Error(
            `Cannot retrieve valid agoda_id for job ${jobId}. Property may not have agoda_id assigned or agoda_id is "0".`
          );
        }

        if (
          !propertyCredentials?.agodaUsername ||
          !propertyCredentials?.agodaPassword
        ) {
          throw new Error(
            `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}. Property may not have agodaUsername or agodaPassword assigned.`
          );
        }

        finalAgodaId = propertyData.agodaId;
        finalAgodaUsername = propertyCredentials.agodaUsername;
        finalAgodaPassword = propertyCredentials.agodaPassword;
      }

      resolved = {
        agodaId: finalAgodaId,
        agodaUsername: finalAgodaUsername,
        agodaPassword: finalAgodaPassword,
        bookingIds: reopenBookingIds,
      };
    } catch (preflightError: any) {
      console.error(
        `Worker: Agoda reopen-case job ${jobId} could not start:`,
        preflightError
      );
      await jobService.updateJobCaseStatus(
        jobId,
        CaseStatus.ParserCaseReopeningFailed
      );
      throw preflightError;
    }

    console.log(
      `Worker: Reopening Agoda case for job ${jobId} (agoda_id: ${resolved.agodaId}, ${resolved.bookingIds.length} booking(s))`
    );

    initializeJobLogging(jobId);
    await dualLogInfo(`Worker: Starting Agoda reopen-case job ${jobId}`, {
      jobId,
      agodaId: resolved.agodaId,
      caseId,
      reopenBookingIds: resolved.bookingIds,
    });

    scrapingStateManager.startScraping(resolved.agodaId, jobId);

    try {
      const reopenResult = await runAgodaReopenCase({
        agodaId: resolved.agodaId,
        jobId,
        agodaUsername: resolved.agodaUsername,
        agodaPassword: resolved.agodaPassword,
        reopenBookingIds: resolved.bookingIds,
        caseId,
        brightDataSessionId,
        windowSize,
        timezone,
        acceptLanguage,
      });

      // Reported through case_status only; job_status still belongs to the
      // property run that produced this case.
      await jobService.updateJobCaseStatus(jobId, CaseStatus.CaseReopen);

      scrapingStateManager.stopScraping();
      await finalizeJobLogging("success");

      const logger = (global as any).getCurrentJobLogger?.();
      const logInfo = logger
        ? {
            logFilePath: logger.getLogFilePath(),
            logEntriesCount: logger.getLogEntriesCount(),
            note: "Log file uploaded to S3 and deleted locally after job completion",
          }
        : null;

      console.log(`Worker: ✅ Agoda reopen-case job ${jobId} completed`);

      return {
        status: 200,
        message: `Agoda case reopened for ${reopenResult.reopenBookingIds.length} booking(s)`,
        agodaId: resolved.agodaId,
        jobId,
        caseId: reopenResult.caseId,
        reopenBookingIds: reopenResult.reopenBookingIds,
        caseStatus: CaseStatus.CaseReopen,
        logInfo,
      };
    } catch (reopenError: any) {
      await dualLogError(
        `Worker: Agoda reopen-case job ${jobId} failed`,
        reopenError,
        { jobId }
      );
      await progressManager.handleJobError(jobId, reopenError);
      scrapingStateManager.stopScraping();

      await jobService.updateJobCaseStatus(
        jobId,
        CaseStatus.ParserCaseReopeningFailed
      );

      await finalizeJobLogging("failed");

      throw reopenError;
    }
  }

  private async handleAgodaRerunFailed(jobData: WorkerJobData): Promise<any> {
    const {
      jobId,
      originalStatus,
      brightDataSessionId,
      windowSize,
      timezone,
      acceptLanguage,
    } = jobData;

    if (!jobId) {
      throw new Error("jobId is required for agoda-rerun-failed jobs");
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
    const propertyData = await jobService.getAgodaIdFromJob(jobId);
    const propertyCredentials =
      await propertyCredentialsService.getCredentialsByJobId(jobId);

    if (!propertyData || !propertyData.agodaId) {
      throw new Error(`Cannot retrieve valid agoda_id for job ${jobId}`);
    }

    if (
      !propertyCredentials?.agodaUsername ||
      !propertyCredentials?.agodaPassword
    ) {
      throw new Error(
        `Cannot retrieve valid Agoda credentials for job ${jobId}`
      );
    }

    const { agodaId } = propertyData;
    const { agodaUsername, agodaPassword } = propertyCredentials;

    console.log(
      `Worker: Rerunning failed/partial Agoda job ${jobId} with agoda_id: ${agodaId}`
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
    await dualLogInfo(`Worker: Starting Agoda job rerun for ${jobId}`, {
      jobId,
      originalStatus,
      agodaId,
      startDate,
      endDate,
    });

    // 7. Start scraping state manager
    scrapingStateManager.startScraping(agodaId, jobId, startDate, endDate);

    try {
      // Generate Bright Data isolation config for rerun job if not provided
      let rerunBrightDataSessionId = brightDataSessionId;
      let rerunWindowSize = windowSize;
      let rerunTimezone = timezone;
      let rerunAcceptLanguage = acceptLanguage;

      if (
        !rerunBrightDataSessionId ||
        !rerunWindowSize ||
        !rerunTimezone ||
        !rerunAcceptLanguage
      ) {
        const {
          getBrightDataSessionId,
          getWindowSize,
          getTimezone,
          getAcceptLanguage,
        } = await import("../common/job-isolation.js");
        rerunBrightDataSessionId =
          rerunBrightDataSessionId || getBrightDataSessionId(jobId);
        rerunWindowSize = rerunWindowSize || getWindowSize(jobId);
        rerunTimezone = rerunTimezone || getTimezone(jobId);
        rerunAcceptLanguage = rerunAcceptLanguage || getAcceptLanguage(jobId);
      }

      // 8. Run the main Agoda scraping function with Bright Data isolation
      await agoda(
        agodaId,
        startDate,
        endDate,
        jobId,
        agodaUsername,
        agodaPassword,
        rerunBrightDataSessionId,
        rerunWindowSize,
        rerunTimezone,
        rerunAcceptLanguage
      );

      // 9. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 10. Determine final status based on completion
      let finalStatus = JobStatus.Completed;
      if (progress.totalItems === 0) {
        finalStatus = JobStatus.Failed;
      } else if (progress.completionPercentage < 100) {
        finalStatus = JobStatus.Partial;
      }

      // 11. Update final job status only if job is still Running (never overwrite Failed/Stopped with Completed)
      const currentJobRerun = await jobService.getJobById(jobId);
      const alreadyTerminalRerun =
        currentJobRerun?.job_status === JobStatus.Failed ||
        currentJobRerun?.job_status === JobStatus.Stopped;
      if (alreadyTerminalRerun) {
        await dualLogInfo(
          `Worker: Skipping status update to ${finalStatus}; job ${jobId} is already ${currentJobRerun?.job_status}`,
          { jobId, currentStatus: currentJobRerun?.job_status }
        );
      } else {
        await jobService.updateJobStatus(jobId, finalStatus);
      }

      if (
        finalStatus === JobStatus.Completed ||
        finalStatus === JobStatus.Partial
      ) {
        await this.maybeUploadAgodaJobItemsToDrive(jobId);
      }

      await this.maybeUpdateHistoricalRunDateOnCompletion(jobId, finalStatus, {
        startDate,
        endDate,
      });

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

      console.log(`Worker: ✅ Agoda job ${jobId} rerun completed successfully`);

      return {
        status: 200,
        message: `Agoda ${originalStatus} job rerun completed successfully`,
        jobId,
        originalStatus,
        finalStatus,
        progress,
        logInfo,
      };
    } catch (error: any) {
      console.error(`Worker: ❌ Error during Agoda job ${jobId} rerun:`, error);
      await dualLogError(`Worker: Agoda job ${jobId} rerun failed`, error, {
        jobId,
      });

      // Update job status to Failed
      await progressManager.handleJobError(jobId, error);

      // Stop scraping state manager
      scrapingStateManager.stopScraping();

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
      // Clean up OTP completion listener
      otpCompletionNotifier.removeAllListeners();

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
