import dotenv from "dotenv";
import mongoose from "mongoose";
import { parentPort, threadId } from "worker_threads";
import {
  clearJobPhone,
  getJobPhone,
  getJobPhoneAndPort,
  getJobPort,
  pickRandomPhoneForJob,
  setJobContact,
} from "../common/job-phone-store.js";
import { dualLogInfo, setCurrentWorkerId } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import {
  JobType,
  WorkerJobData,
  WorkerMessage,
  WorkerMessageType,
} from "../common/worker-types.js";

dotenv.config();

/**
 * OTP-aware worker thread.
 *
 * This worker owns the per-thread half of the OTP contract with
 * {@link ../common/otp-aware-worker-pool.js}: it leases the phone/port contact
 * for a job before the job runs and releases it afterwards, so two threads can
 * never drive a Booking.com SMS OTP on the same number at the same time. It
 * also relays job lifecycle messages (start / progress / complete / error) and
 * honours stop commands from the main thread.
 *
 * The scraping job payloads (Expedia runs, Booking VCC runs, group runs) were
 * removed with the rest of the scraping features — this build only exposes the
 * Booking.com property check, which runs on the main thread. The pool, the OTP
 * lease lifecycle and the message protocol are kept intact so a job payload can
 * be registered in {@link ScrapingWorker.runJobPayload} without rebuilding any
 * of the threading or OTP machinery.
 */
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

      // Handle job data
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

  /**
   * Lease the OTP phone/port contact for this job (and, for a Booking group,
   * for every step in the group so they all share one number).
   */
  private leaseOtpContact(jobData: WorkerJobData): void {
    const isGroup =
      jobData.jobType === JobType.BookingRunGroup &&
      Array.isArray(jobData.bookingGroup);

    if (jobData.selectedContact) {
      // Round-robin assignment decided on the main thread.
      setJobContact(jobData.jobId, jobData.selectedContact);
      if (isGroup) {
        for (const step of jobData.bookingGroup!) {
          if (step?.jobId) {
            setJobContact(step.jobId, jobData.selectedContact);
          }
        }
      }
      return;
    }

    pickRandomPhoneForJob(jobData.jobId);
    if (isGroup) {
      const locked = getJobPhoneAndPort(jobData.jobId);
      if (locked?.phone) {
        for (const step of jobData.bookingGroup!) {
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

  /** Release the OTP phone/port contact leased by {@link leaseOtpContact}. */
  private releaseOtpContact(jobData: WorkerJobData): void {
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
  }

  /**
   * Runs the actual work for a queued job.
   *
   * No scraping payload ships in this build (see the class doc) — register one
   * here and the surrounding OTP lease, messaging and stop handling apply to it
   * unchanged.
   */
  private async runJobPayload(jobData: WorkerJobData): Promise<any> {
    throw new Error(
      `No job payload is registered for job type "${jobData.jobType}" — this build only exposes the Booking.com property check, which runs on the main thread.`
    );
  }

  private async executeJob(jobData: WorkerJobData): Promise<void> {
    this.currentJobId = jobData.jobId;

    this.leaseOtpContact(jobData);

    const lockedPhone =
      jobData.selectedContact?.phone ?? getJobPhone(jobData.jobId) ?? "";
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
      const result = await this.runJobPayload(jobData);

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
      this.releaseOtpContact(jobData);
      this.currentJobId = undefined;
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
