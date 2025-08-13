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
import agoda from "../agoda.js";
import { jobService } from "../services/job.service.js";
import { JobStatus } from "../models/job.model.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobQueueUrlService } from "../services/job-queue-url.service.js";

// Load environment variables
dotenv.config();

class AgodaScrapingWorker {
  private currentJobId?: string;
  private isShuttingDown = false;

  constructor() {
    this.setupEventHandlers();
    this.initializeDatabase();
  }

  private setupEventHandlers(): void {
    if (!parentPort) {
      throw new Error("Agoda Worker must be run as a worker thread");
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
      console.log("Agoda Worker: Connected to MongoDB successfully");
    } catch (error) {
      console.error("Agoda Worker: MongoDB connection error:", error);
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
        case "agoda-property-run":
          result = await this.handleAgodaPropertyRun(jobData);
          break;

        case "agoda-rerun-failed":
          result = await this.handleAgodaRerunFailed(jobData);
          break;

        default:
          throw new Error(`Unknown Agoda job type: ${jobData.jobType}`);
      }

      this.sendMessage({
        type: "job-complete",
        jobId: jobData.jobId,
        data: result,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`Agoda Worker job ${jobData.jobId} failed:`, error);

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

  private async handleAgodaPropertyRun(jobData: WorkerJobData): Promise<any> {
    const { jobId, startDate, endDate, agodaId, agodaUsername, agodaPassword } =
      jobData;

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

    console.log(`Agoda Worker: Using agoda_id: ${finalAgodaId} for scraping`);

    // 3. Update job status to Running
    console.log(`Agoda Worker: Starting job ${jobId}...`);
    await jobService.startJob(jobId);

    // 4. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Agoda Worker: Starting property scraping job ${jobId}`, {
      jobId,
      agodaId: finalAgodaId,
      startDate,
      endDate,
    });

    // 5. Start scraping state manager
    scrapingStateManager.startScraping(finalAgodaId, jobId, startDate, endDate);

    try {
      // 6. Run the main Agoda scraping function
      await agoda(
        finalAgodaId,
        startDate,
        endDate,
        jobId,
        finalAgodaUsername,
        finalAgodaPassword
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

      // 9. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus);

      // 10. Handle job completion for URL queue management
      await jobQueueUrlService.handleJobCompletion(jobId, finalStatus);

      // 11. Stop scraping state manager
      scrapingStateManager.stopScraping();

      // 12. Finalize logging
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

      console.log(`Agoda Worker: ✅ Job ${jobId} completed successfully`);

      return {
        status: 200,
        message: `Agoda property scraping ${finalStatus.toLowerCase()} successfully`,
        agodaId: finalAgodaId,
        jobId: jobId,
        progress: progress,
        finalStatus: finalStatus,
        logInfo: logInfo,
      };
    } catch (scrapingError) {
      // Mark job as failed on scraping error
      await dualLogError(`Agoda Worker: Job ${jobId} failed`, scrapingError, {
        jobId,
      });
      await progressManager.handleJobError(jobId, scrapingError);

      // Release URL back to Available status on error
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        scrapingError instanceof Error ? scrapingError.message : "Unknown error"
      );

      scrapingStateManager.stopScraping();

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw scrapingError;
    }
  }

  private async handleAgodaRerunFailed(jobData: WorkerJobData): Promise<any> {
    const { jobId, originalStatus } = jobData;

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
      `Agoda Worker: Rerunning failed/partial job ${jobId} with agoda_id: ${agodaId}`
    );

    // 5. Reset job status to Pending, then to Running
    console.log(
      `Agoda Worker: Resetting job ${jobId} status from ${originalStatus} to Pending...`
    );
    await jobService.updateJobStatus(jobId, JobStatus.Pending);

    console.log(`Agoda Worker: Starting job ${jobId}...`);
    await jobService.startJob(jobId);

    // 6. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Agoda Worker: Starting job rerun for ${jobId}`, {
      jobId,
      originalStatus,
      agodaId,
      startDate,
      endDate,
    });

    // 7. Start scraping state manager
    scrapingStateManager.startScraping(agodaId, jobId, startDate, endDate);

    try {
      // 8. Run the main Agoda scraping function
      await agoda(
        agodaId,
        startDate,
        endDate,
        jobId,
        agodaUsername,
        agodaPassword
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

      // 11. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus);

      // 12. Handle job completion for URL queue management
      await jobQueueUrlService.handleJobCompletion(jobId, finalStatus);

      // 13. Stop scraping state manager
      scrapingStateManager.stopScraping();

      // 14. Finalize logging
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

      console.log(`Agoda Worker: ✅ Job ${jobId} rerun completed successfully`);

      return {
        status: 200,
        message: `Agoda ${originalStatus} job rerun completed successfully`,
        jobId,
        originalStatus,
        finalStatus,
        progress,
        logInfo,
      };
    } catch (error) {
      console.error(`Agoda Worker: ❌ Error during job ${jobId} rerun:`, error);
      await dualLogError(`Agoda Worker: Job ${jobId} rerun failed`, error, {
        jobId,
      });

      // Update job status to Failed
      await progressManager.handleJobError(jobId, error);

      // Release URL back to Available status on error
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        error instanceof Error ? error.message : "Unknown error"
      );

      // Stop scraping state manager
      scrapingStateManager.stopScraping();

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw error;
    }
  }

  private async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    console.log("Agoda Worker: Shutting down...");

    try {
      // Stop any current scraping
      scrapingStateManager.stopScraping();

      // Close database connection
      await mongoose.disconnect();
      console.log("Agoda Worker: Disconnected from MongoDB");

      // Exit gracefully
      process.exit(0);
    } catch (error) {
      console.error("Agoda Worker: Error during shutdown:", error);
      process.exit(1);
    }
  }
}

// Initialize the worker
try {
  new AgodaScrapingWorker();
} catch (error) {
  console.error("Agoda Worker: Failed to initialize:", error);
  process.exit(1);
}
