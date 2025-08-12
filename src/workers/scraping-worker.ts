import dotenv from "dotenv";
import mongoose from "mongoose";
import { parentPort } from "worker_threads";
import { WorkerJobData, WorkerMessage } from "../common/worker-types.js";

// Import the main functions
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
} from "../common/log-helper.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import main from "../main.js";
import reservation from "../reservation/reservation.js";
import { jobService } from "../services/job.service.js";

// Load environment variables
dotenv.config();

class ScrapingWorker {
  private currentJobId?: string;
  private isShuttingDown = false;

  constructor() {
    this.setupEventHandlers();
    this.initializeDatabase();
  }

  private setupEventHandlers(): void {
    if (!parentPort) {
      throw new Error("Worker must be run as a worker thread");
    }

    // Listen for job data from main thread
    parentPort.on("message", async (jobData: WorkerJobData) => {
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

  private sendMessage(message: WorkerMessage): void {
    if (parentPort && !this.isShuttingDown) {
      parentPort.postMessage(message);
    }
  }

  private async executeJob(jobData: WorkerJobData): Promise<void> {
    this.currentJobId = jobData.jobId;

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

      // 9. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus as any);

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
