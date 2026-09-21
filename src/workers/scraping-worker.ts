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
import { jobService } from "../services/job.service.js";
import { propertyCredentialsService as tripPropertyCredentialsService } from "../services/job-credentials.service.js";

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

    this.sendMessage({
      type: WorkerMessageType.JobStart,
      jobId: jobData.jobId,
      data: { jobType: jobData.jobType, startTime: new Date(), threadId },
      timestamp: new Date(),
    });

    try {
      let result;

      switch (jobData.jobType) {
        case JobType.TripPropertyRun:
          result = await this.handleTripPropertyRun(jobData);
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

  /**
   * Trip.com property job. Trip.com's own shared-Gmail-inbox lock
   * (`otpStatusService`, `otp_statuses` collection, platform `trip.com`)
   * is acquired/released *inside* TripScraper itself (see
   * `handle2FA`/`solveVccOtpChallenge`), so multiple Trip jobs can still be
   * assigned to different worker threads and run concurrently — login,
   * property search, etc. all proceed in parallel; only the actual
   * email-verification step serializes across jobs.
   */
  private async handleTripPropertyRun(jobData: WorkerJobData): Promise<any> {
    const { jobId } = jobData;

    if (!jobId) {
      throw new Error("jobId is required for trip-property-run jobs");
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

    // 2. The job's own end_date (MM/DD/YYYY) anchors TripScraper's 180-day
    // VCC lookback window — Trip doesn't use a start date at all.
    const endDate = jobData.endDate || validation.job?.end_date;
    if (!endDate) {
      throw new Error(
        `Job ${jobId} has no end_date set — required to run the Trip.com VCC lookback query.`
      );
    }

    // 3. Get property name + DB id from the job's property
    const propertyData = await jobService.getTripPropertyFromJob(jobId);
    if (!propertyData) {
      throw new Error(
        `Cannot retrieve a property name for job ${jobId}. Property may not be assigned or has no property_name.`
      );
    }

    // 4. Get Trip.com credentials from the job's property
    const credentials =
      await tripPropertyCredentialsService.getTripCredentialsFromJob(jobId);
    if (!credentials?.tripUsername || !credentials?.tripPassword) {
      throw new Error(
        `Cannot retrieve valid tripUsername/tripPassword for job ${jobId}. Property may not have Trip.com credentials assigned.`
      );
    }

    const { propertyName, propertyIdForDb } = propertyData;
    const { tripUsername, tripPassword, tripVccPassword } = credentials;

    console.log(
      `Worker: Using property "${propertyName}" for Trip.com job ${jobId}`
    );

    // 5. Update job status to Running
    console.log(`Worker: Starting job ${jobId}...`);
    await jobService.startJob(jobId, this.workerPoolAssignmentTag(jobData));

    // 6. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Worker: Starting Trip.com property scraping job ${jobId}`, {
      jobId,
      propertyName,
      endDate,
    });

    // 7. Start scraping state manager
    scrapingStateManager.startScraping(propertyName, jobId, undefined, endDate);

    try {
      // 8. Run the multi-platform scraping function for Trip.com
      await mainMultiPlatform({
        platform: "trip",
        propertyId: propertyName,
        propertyIdForDb,
        endDate,
        jobId,
        user_email: tripUsername,
        user_password: tripPassword,
        tripVccPassword,
      });

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

      // 12. Stop scraping state manager
      scrapingStateManager.stopScraping();

      // 13. Finalize logging
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

      console.log(`Worker: Trip.com job ${jobId} completed successfully`);

      return {
        status: 200,
        message: `Property scraping ${finalStatus.toLowerCase()} successfully`,
        propertyName,
        jobId,
        progress,
        finalStatus,
        logInfo,
      };
    } catch (scrapingError) {
      await dualLogError(`Worker: Trip.com job ${jobId} failed`, scrapingError, {
        jobId,
      });
      await progressManager.handleJobError(jobId, scrapingError);
      scrapingStateManager.stopScraping();

      await jobService.failJobSafe(
        jobId,
        scrapingError instanceof Error
          ? scrapingError.message
          : String(scrapingError)
      );

      await finalizeJobLogging("failed");

      throw scrapingError;
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
