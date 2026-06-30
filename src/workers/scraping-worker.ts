import dotenv from "dotenv";
import mongoose from "mongoose";
import { parentPort } from "worker_threads";
import agoda from "../agoda.js";
import {
  getFailedReasonForUser,
  isStatusAlreadySaved,
  markStatusSaved,
} from "../common/failed-reason.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
} from "../common/log-helper.js";
import { otpCompletionNotifier } from "../common/otp-completion-notifier.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { WorkerJobData, WorkerMessage } from "../common/worker-types.js";
import { JobStatus } from "../models/job.model.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobService } from "../services/job.service.js";

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

    parentPort.on("message", async (message: any) => {
      if (message.type === "stop" && message.jobId) {
        const state = scrapingStateManager.getState();
        const isCurrentJob =
          this.currentJobId === message.jobId ||
          state.currentJobId === message.jobId;

        if (isCurrentJob) {
          scrapingStateManager.stopScraping();
          this.sendMessage({
            type: "job-progress",
            jobId: message.jobId,
            data: {
              message: `Job ${message.jobId} stopped by user request`,
              stopped: true,
            },
            timestamp: new Date(),
          });
        }
        return;
      }

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

    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private async initializeDatabase(): Promise<void> {
    const DATABASE_URI = process.env.DATABASE_URI;
    if (!DATABASE_URI) {
      throw new Error("DATABASE_URI environment variable is not defined");
    }
    await mongoose.connect(DATABASE_URI);
    console.log("Worker: Connected to MongoDB successfully");
  }

  private setupOtpCompletionListener(): void {
    otpCompletionNotifier.onOtpCompleted((jobId: string) => {
      if (this.currentJobId === jobId) {
        this.sendMessage({
          type: "job-progress",
          jobId,
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

  private async executeJob(jobData: WorkerJobData): Promise<void> {
    this.currentJobId = jobData.jobId;

    this.sendMessage({
      type: "job-start",
      jobId: jobData.jobId,
      data: { jobType: jobData.jobType, startTime: new Date() },
      timestamp: new Date(),
    });

    try {
      if (jobData.jobType !== "agoda-property-run") {
        throw new Error(`Unknown job type: ${jobData.jobType}`);
      }

      const result = await this.handleAgodaPropertyRun(jobData);

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

    const validation = await jobService.validateJob(jobId);
    if (!validation.exists) {
      throw new Error(`Job with ID ${jobId} not found`);
    }
    if (!validation.canRun) {
      throw new Error(
        `Job ${jobId} is not in a runnable state. Current status: ${validation.job?.job_status}`
      );
    }

    let finalAgodaId = agodaId;
    let finalAgodaUsername = agodaUsername;
    let finalAgodaPassword = agodaPassword;

    if (!finalAgodaId || !finalAgodaUsername || !finalAgodaPassword) {
      const propertyData = await jobService.getAgodaIdFromJob(jobId);
      const propertyCredentials =
        await propertyCredentialsService.getCredentialsByJobId(jobId);

      if (!propertyData?.agodaId) {
        throw new Error(
          `Cannot retrieve valid agoda_id for job ${jobId}. Property may not have agoda_id assigned or agoda_id is "0".`
        );
      }
      if (
        !propertyCredentials?.agodaUsername ||
        !propertyCredentials?.agodaPassword
      ) {
        throw new Error(
          `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}.`
        );
      }

      finalAgodaId = propertyData.agodaId;
      finalAgodaUsername = propertyCredentials.agodaUsername;
      finalAgodaPassword = propertyCredentials.agodaPassword;
    }

    await jobService.startJob(jobId);
    initializeJobLogging(jobId);
    await dualLogInfo(`Worker: Starting Agoda property check job ${jobId}`, {
      jobId,
      agodaId: finalAgodaId,
      startDate,
      endDate,
    });

    scrapingStateManager.startScraping(finalAgodaId, jobId, startDate, endDate);

    try {
      const checkResult = await agoda(
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

      const progress = await jobService.getJobProgress(jobId);
      const finalStatus = checkResult.propertyFound
        ? JobStatus.Completed
        : JobStatus.Failed;

      const currentJob = await jobService.getJobById(jobId);
      const alreadyTerminal =
        currentJob?.job_status === JobStatus.Failed ||
        currentJob?.job_status === JobStatus.Stopped;

      if (!alreadyTerminal) {
        await jobService.updateJobStatus(jobId, finalStatus);
      }

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

      return {
        status: 200,
        message: `Agoda property check ${finalStatus.toLowerCase()} successfully`,
        agodaId: finalAgodaId,
        jobId,
        propertyFound: checkResult.propertyFound,
        progress,
        finalStatus,
        logInfo,
      };
    } catch (scrapingError: any) {
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

      await finalizeJobLogging("failed");
      throw scrapingError;
    }
  }

  private async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    otpCompletionNotifier.removeAllListeners();
    scrapingStateManager.stopScraping();
    await mongoose.disconnect();
    process.exit(0);
  }
}

new ScrapingWorker();
