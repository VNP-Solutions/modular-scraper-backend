import dotenv from "dotenv";
import { EventEmitter } from "events";
import { Types } from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import { CaseStatus, JobStatus } from "../models/job.model.js";
import { OtpPlatform } from "../models/otp-status.model.js";
import { jobService } from "../services/job.service.js";
import { otpStatusManager, OtpStatusManager } from "./otp-status-manager.js";
import {
  WorkerInfo,
  WorkerJobData,
  WorkerMessage,
  WorkerPoolConfig,
  WorkerPoolStatus,
  WorkerResponse,
} from "./worker-types.js";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ActiveWorker {
  worker: Worker;
  info: WorkerInfo;
  resolve?: (value: WorkerResponse) => void;
  reject?: (reason: any) => void;
}

interface QueuedJob {
  jobData: WorkerJobData;
  resolve: (value: WorkerResponse) => void;
  reject: (reason: any) => void;
  queuedAt: Date;
  requiresOtp: boolean;
}

export class OtpAwareWorkerPool extends EventEmitter {
  private workers: Map<string, ActiveWorker> = new Map();
  private jobQueue: QueuedJob[] = [];
  private config: WorkerPoolConfig;
  private isShuttingDown = false;
  private otpManager: OtpStatusManager;
  private isProcessingQueue = false;

  constructor(config: Partial<WorkerPoolConfig> = {}) {
    super();

    this.config = {
      maxWorkers:
        config.maxWorkers || parseInt(process.env.MAX_WORKER_THREADS || "3"),
      queueSize:
        config.queueSize || parseInt(process.env.WORKER_QUEUE_SIZE || "10"),
    };

    this.otpManager = otpStatusManager;

    console.log(`OTP-Aware Worker pool initialized with config:`, this.config);
    this.initializeSystem();
  }

  private async initializeSystem(): Promise<void> {
    try {
      // Initialize OTP status manager
      await this.otpManager.initialize();

      // Set up OTP event listeners
      this.otpManager.on("otpReleased", this.onOtpReleased.bind(this));
      this.otpManager.on("otpReserved", this.onOtpReserved.bind(this));

      // Set up worker ready listener to process queue when worker becomes available
      this.on("workerReady", () => {
        this.processQueue();
      });

      // Initialize workers
      this.initializeWorkers();

      console.log("OTP-Aware Worker Pool system initialized successfully");
    } catch (error) {
      console.error(
        "Failed to initialize OTP-Aware Worker Pool system:",
        error
      );
      throw error;
    }
  }

  private initializeWorkers(): void {
    for (let i = 0; i < this.config.maxWorkers; i++) {
      this.createWorker(`worker-${i}`);
    }
  }

  private createWorker(workerId: string): void {
    try {
      // Determine the correct worker path based on environment
      const isDevelopment = process.env.NODE_ENV !== "production";
      let workerPath: string;

      if (isDevelopment) {
        // In development, use the TypeScript loader to run the .ts file
        workerPath = path.resolve(__dirname, "../workers/scraping-worker.ts");
      } else {
        // In production, use the compiled .js file
        workerPath = path.resolve(__dirname, "../workers/scraping-worker.js");
      }

      console.log(`Creating OTP-aware worker with path: ${workerPath}`);

      const worker = new Worker(workerPath, {
        execArgv: isDevelopment ? ["--loader", "ts-node/esm"] : [],
      });

      const workerInfo: WorkerInfo = {
        id: workerId,
        isAvailable: true,
        lastActivity: new Date(),
      };

      const activeWorker: ActiveWorker = {
        worker,
        info: workerInfo,
      };

      // Handle worker messages
      worker.on("message", (message: WorkerMessage) => {
        this.handleWorkerMessage(workerId, message);
      });

      // Handle worker errors
      worker.on("error", (error) => {
        console.error(`OTP-aware worker ${workerId} error:`, error);
        this.handleWorkerError(workerId, error);
      });

      // Handle worker exit
      worker.on("exit", (code) => {
        console.log(`OTP-aware worker ${workerId} exited with code ${code}`);
        this.handleWorkerExit(workerId, code);
      });

      this.workers.set(workerId, activeWorker);
      console.log(`OTP-aware worker ${workerId} created and ready`);

      this.emit("workerReady", workerId);
    } catch (error) {
      console.error(`Failed to create OTP-aware worker ${workerId}:`, error);
    }
  }

  private handleWorkerMessage(workerId: string, message: WorkerMessage): void {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

    activeWorker.info.lastActivity = new Date();

    switch (message.type) {
      case "job-start":
        console.log(
          `\x1b[32mOTP-aware worker ${workerId} started job ${message.jobId}\x1b[0m`
        );
        this.emit("jobStart", {
          workerId,
          jobId: message.jobId,
          data: message.data,
        });
        break;

      case "job-progress":
        // Check if this is OTP completion
        if (message.data?.otpCompleted === true) {
          this.handleOtpCompleted(workerId, message.jobId);
        }

        console.log(
          `\x1b[32mOTP-aware worker ${workerId} progress for job ${message.jobId}:\x1b[0m`,
          message.data
        );
        this.emit("jobProgress", {
          workerId,
          jobId: message.jobId,
          data: message.data,
        });
        break;

      case "job-complete":
        console.log(
          `OTP-aware worker ${workerId} completed job ${message.jobId}`
        );
        this.handleJobComplete(workerId, message);
        break;

      case "job-error":
        console.error(
          `OTP-aware worker ${workerId} error for job ${message.jobId}:`,
          message.data
        );
        this.handleJobError(workerId, message);
        break;

      case "job-log":
        console.log(
          `OTP-aware worker ${workerId} log for job ${message.jobId}:`,
          message.data
        );
        this.emit("jobLog", {
          workerId,
          jobId: message.jobId,
          data: message.data,
        });
        break;
    }
  }

  private async handleOtpCompleted(
    workerId: string,
    jobId: string
  ): Promise<void> {
    console.log(`OTP work completed for job ${jobId} on worker ${workerId}`);

    // Release OTP so other jobs can use it
    const released = await this.otpManager.releaseOtp(jobId);
    if (released) {
      console.log(`OTP released for job ${jobId}, processing queue...`);
      // Process queue will be triggered by the otpReleased event
    } else {
      console.warn(`Failed to release OTP for job ${jobId}`);
    }
  }

  private handleJobComplete(workerId: string, message: WorkerMessage): void {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

    // Mark worker as available
    activeWorker.info.isAvailable = true;
    activeWorker.info.currentJobId = undefined;
    activeWorker.info.startTime = undefined;

    // Resolve the promise
    if (activeWorker.resolve) {
      const response: WorkerResponse = {
        success: true,
        data: message.data,
        jobId: message.jobId,
        finalStatus: message.data?.finalStatus,
        progress: message.data?.progress,
        logInfo: message.data?.logInfo,
      };
      activeWorker.resolve(response);
      activeWorker.resolve = undefined;
      activeWorker.reject = undefined;
    }

    this.emit("jobComplete", {
      workerId,
      jobId: message.jobId,
      data: message.data,
    });

    // Process next job in queue
    this.processQueue();
  }

  private async handleJobError(
    workerId: string,
    message: WorkerMessage
  ): Promise<void> {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

    const jobId = message.jobId;

    // If this job had reserved OTP, release it
    if (activeWorker.info.currentJobId === jobId) {
      console.log(`Releasing OTP for failed job ${jobId}`);
      await this.otpManager.releaseOtp(jobId);
    }

    // Mark worker as available
    activeWorker.info.isAvailable = true;
    activeWorker.info.currentJobId = undefined;
    activeWorker.info.startTime = undefined;

    // Reject the promise
    if (activeWorker.reject) {
      const response: WorkerResponse = {
        success: false,
        error: message.data?.error || "Unknown worker error",
        jobId: message.jobId,
      };
      activeWorker.reject(response);
      activeWorker.resolve = undefined;
      activeWorker.reject = undefined;
    }

    this.emit("jobError", {
      workerId,
      jobId: message.jobId,
      error: message.data,
    });

    // Process next job in queue
    this.processQueue();
  }

  private async handleWorkerError(
    workerId: string,
    error: Error
  ): Promise<void> {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

    console.error(`OTP-aware worker ${workerId} encountered an error:`, error);

    // If this worker had a job that reserved OTP, release it
    if (activeWorker.info.currentJobId) {
      console.log(
        `Releasing OTP for worker error on job ${activeWorker.info.currentJobId}`
      );
      await this.otpManager.releaseOtp(activeWorker.info.currentJobId);
    }

    // Reject current job if any
    if (activeWorker.reject) {
      activeWorker.reject(new Error(`Worker error: ${error.message}`));
    }

    // Recreate the worker
    this.recreateWorker(workerId);
  }

  private async handleWorkerExit(
    workerId: string,
    code: number
  ): Promise<void> {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

    console.log(`OTP-aware worker ${workerId} exited with code ${code}`);

    // If this worker had a job that reserved OTP, release it
    if (activeWorker.info.currentJobId) {
      console.log(
        `Releasing OTP for worker exit on job ${activeWorker.info.currentJobId}`
      );
      await this.otpManager.releaseOtp(activeWorker.info.currentJobId);
    }

    // Reject current job if any
    if (activeWorker.reject) {
      activeWorker.reject(new Error(`Worker exited with code ${code}`));
    }

    // Recreate the worker if not shutting down
    if (!this.isShuttingDown) {
      this.recreateWorker(workerId);
    }
  }

  private recreateWorker(workerId: string): void {
    try {
      // Clean up the old worker
      const activeWorker = this.workers.get(workerId);
      if (activeWorker) {
        try {
          activeWorker.worker.terminate();
        } catch (error) {
          console.error(
            `Error terminating OTP-aware worker ${workerId}:`,
            error
          );
        }
        this.workers.delete(workerId);
      }

      // Create a new worker
      setTimeout(() => {
        if (!this.isShuttingDown) {
          this.createWorker(workerId);
        }
      }, 1000); // Wait 1 second before recreating
    } catch (error) {
      console.error(`Error recreating OTP-aware worker ${workerId}:`, error);
    }
  }

  public async executeJob(jobData: WorkerJobData): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      // Check if queue is full
      if (this.jobQueue.length >= this.config.queueSize) {
        reject(new Error("Job queue is full"));
        return;
      }

      // Determine if this job requires OTP
      const requiresOtp = this.jobRequiresOtp(jobData);

      const queuedJob: QueuedJob = {
        jobData,
        resolve,
        reject,
        queuedAt: new Date(),
        requiresOtp,
      };

      // Try to assign job immediately
      this.tryAssignJob(queuedJob);
    });
  }

  private jobRequiresOtp(jobData: WorkerJobData): boolean {
    // Jobs that require OTP verification
    return [
      "property-run",
      "graphql-run",
      "agoda-property-run",
      "agoda-reopen-case",
    ].includes(jobData.jobType);
  }

  /**
   * Update job status to InQueue if jobId is a valid MongoDB ObjectId
   * This is called when a job is added to the queue
   */
  private async updateJobStatusToInQueue(jobData: WorkerJobData): Promise<void> {
    const { jobId, jobType } = jobData;

    // Reopen runs report through case_status and must leave job_status alone,
    // since the job they attach to has usually already finished.
    if (jobType === "agoda-reopen-case") {
      try {
        if (Types.ObjectId.isValid(jobId)) {
          await jobService.updateJobCaseStatus(jobId, CaseStatus.CaseInQueue);
        }
      } catch (error) {
        console.error(
          `Error updating job ${jobId} case_status to CaseInQueue:`,
          error
        );
      }
      return;
    }

    try {
      // Only update status for valid MongoDB ObjectIds (database jobs)
      // Some jobs like reservation-run use generated IDs and don't exist in database
      if (Types.ObjectId.isValid(jobId)) {
        await jobService.updateJobStatus(jobId, JobStatus.InQueue);
      }
    } catch (error) {
      // Log error but don't fail the queue operation
      console.error(`Error updating job ${jobId} status to InQueue:`, error);
    }
  }

  private getJobPlatform(jobData: WorkerJobData): OtpPlatform {
    // Determine platform based on job type
    if (
      [
        "property-run",
        "graphql-run",
        "rerun-failed",
        "reservation-run",
      ].includes(jobData.jobType)
    ) {
      return OtpPlatform.Expedia;
    } else if (
      [
        "agoda-property-run",
        "agoda-rerun-failed",
        "agoda-reopen-case",
      ].includes(jobData.jobType)
    ) {
      return OtpPlatform.Agoda;
    }
    // Default to Expedia for unknown job types
    return OtpPlatform.Expedia;
  }

  private async tryAssignJob(queuedJob: QueuedJob): Promise<void> {
    // Check worker availability
    const availableWorker = this.getAvailableWorker();
    if (!availableWorker) {
      // No workers available, add to queue
      this.jobQueue.push(queuedJob);
      await this.updateJobStatusToInQueue(queuedJob.jobData);
      console.log(
        `\x1b[33mJob ${queuedJob.jobData.jobId} queued (no workers). Queue size: ${this.jobQueue.length}\x1b[0m`
      );
      return;
    }

    // If job requires OTP, check OTP availability
    if (queuedJob.requiresOtp && !this.otpManager.isOtpAvailable()) {
      // OTP not available, add to queue
      this.jobQueue.push(queuedJob);
      await this.updateJobStatusToInQueue(queuedJob.jobData);
      console.log(
        `\x1b[33mJob ${queuedJob.jobData.jobId} queued (OTP occupied). Queue size: ${this.jobQueue.length}\x1b[0m`
      );
      return;
    }

    // Both worker and OTP (if needed) are available
    if (queuedJob.requiresOtp) {
      // Reserve OTP before assigning job
      const platform = this.getJobPlatform(queuedJob.jobData);
      const otpReserved = await this.otpManager.reserveOtp(
        queuedJob.jobData.jobId,
        platform
      );
      if (!otpReserved) {
        // Failed to reserve OTP (race condition), add to queue
        this.jobQueue.push(queuedJob);
        await this.updateJobStatusToInQueue(queuedJob.jobData);
        console.log(
          `Job ${queuedJob.jobData.jobId} queued (OTP reservation failed). Queue size: ${this.jobQueue.length}`
        );
        return;
      }
    }

    // Assign job to worker
    this.assignJobToWorker(
      availableWorker,
      queuedJob.jobData,
      queuedJob.resolve,
      queuedJob.reject
    );
  }

  private getAvailableWorker(): string | null {
    for (const [workerId, activeWorker] of this.workers) {
      if (activeWorker.info.isAvailable) {
        return workerId;
      }
    }
    return null;
  }

  private assignJobToWorker(
    workerId: string,
    jobData: WorkerJobData,
    resolve: (value: WorkerResponse) => void,
    reject: (reason: any) => void
  ): void {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker || !activeWorker.info.isAvailable) {
      reject(new Error("Worker not available"));
      return;
    }

    // Mark worker as busy
    activeWorker.info.isAvailable = false;
    activeWorker.info.currentJobId = jobData.jobId;
    activeWorker.info.startTime = new Date();
    activeWorker.resolve = resolve;
    activeWorker.reject = reject;

    // Send job to worker
    try {
      activeWorker.worker.postMessage(jobData);
      console.log(
        `\x1b[32mJob ${jobData.jobId} assigned to OTP-aware worker ${workerId}\x1b[0m`
      );
    } catch (error) {
      console.error(
        `Error sending job to OTP-aware worker ${workerId}:`,
        error
      );
      reject(error);

      // Reset worker state
      activeWorker.info.isAvailable = true;
      activeWorker.info.currentJobId = undefined;
      activeWorker.info.startTime = undefined;
      activeWorker.resolve = undefined;
      activeWorker.reject = undefined;
    }
  }

  private processQueue(): void {
    if (this.isProcessingQueue || this.jobQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    // Find the next job that can be processed
    for (let i = 0; i < this.jobQueue.length; i++) {
      const queuedJob = this.jobQueue[i];

      // Check if requirements are met
      const availableWorker = this.getAvailableWorker();
      const otpAvailable =
        !queuedJob.requiresOtp || this.otpManager.isOtpAvailable();

      if (availableWorker && otpAvailable) {
        // Remove job from queue
        this.jobQueue.splice(i, 1);

        console.log(
          `Processing queued job ${queuedJob.jobData.jobId}. Queue size: ${this.jobQueue.length}`
        );

        // Try to assign the job
        this.tryAssignJob(queuedJob);
        break; // Process one job at a time
      }
    }

    this.isProcessingQueue = false;
  }

  private onOtpReleased(): void {
    console.log("OTP released event received, processing queue...");
    this.processQueue();
  }

  private onOtpReserved(jobId: string | null, platform?: OtpPlatform): void {
    console.log(
      `OTP reserved event received for job ${jobId} on platform ${platform}`
    );
  }

  public getStatus(): WorkerPoolStatus {
    const workers: WorkerInfo[] = [];
    let availableCount = 0;
    let busyCount = 0;

    for (const [workerId, activeWorker] of this.workers) {
      workers.push({ ...activeWorker.info });
      if (activeWorker.info.isAvailable) {
        availableCount++;
      } else {
        busyCount++;
      }
    }

    return {
      totalWorkers: this.workers.size,
      availableWorkers: availableCount,
      busyWorkers: busyCount,
      queuedJobs: this.jobQueue.length,
      workers,
    };
  }

  public getOtpStatus() {
    return this.otpManager.getCurrentStatus();
  }

  public hasAvailableWorkers(): boolean {
    return this.getStatus().availableWorkers > 0;
  }

  public isQueueFull(): boolean {
    return this.jobQueue.length >= this.config.queueSize;
  }

  public async stopJob(jobId: string): Promise<boolean> {
    console.log(`Attempting to stop job: ${jobId}`);

    // First, check if job is in queue and remove it
    const queueIndex = this.jobQueue.findIndex(
      (queuedJob) => queuedJob.jobData.jobId === jobId
    );
    if (queueIndex !== -1) {
      const removedJob = this.jobQueue.splice(queueIndex, 1)[0];
      removedJob.reject(new Error(`Job ${jobId} was stopped before execution`));
      console.log(`Job ${jobId} removed from queue`);
      return true;
    }

    // Find worker currently executing this job
    let targetWorker: ActiveWorker | undefined;
    let targetWorkerId: string | undefined;

    for (const [workerId, activeWorker] of this.workers) {
      if (activeWorker.info.currentJobId === jobId) {
        targetWorker = activeWorker;
        targetWorkerId = workerId;
        break;
      }
    }

    if (!targetWorker || !targetWorkerId) {
      console.log(`Job ${jobId} not found in active workers or queue`);
      return false;
    }

    try {
      // Release OTP if this job had reserved it
      await this.otpManager.releaseOtp(jobId);

      // Send stop message to worker first (if worker supports it)
      targetWorker.worker.postMessage({ type: "stop", jobId });

      // Give worker a moment to handle stop gracefully
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Terminate the worker and recreate it
      await targetWorker.worker.terminate();
      console.log(
        `OTP-aware worker ${targetWorkerId} terminated for job ${jobId}`
      );

      // Resolve the promise with stopped status
      if (targetWorker.resolve) {
        targetWorker.resolve({
          success: false,
          error: `Job ${jobId} was stopped by user request`,
          jobId: jobId,
          data: {
            status: 500,
            message: `Job ${jobId} was stopped by user request`,
            jobId: jobId,
            finalStatus: "Stopped",
          },
        });
      }

      // Remove the old worker and create a new one
      this.workers.delete(targetWorkerId);
      this.createWorker(targetWorkerId);

      console.log(
        `Job ${jobId} stopped and OTP-aware worker ${targetWorkerId} recreated`
      );

      // Process next job in queue after worker is recreated
      // Small delay to ensure worker is fully initialized
      setTimeout(() => {
        this.processQueue();
      }, 500);

      return true;
    } catch (error) {
      console.error(`Error stopping job ${jobId}:`, error);
      return false;
    }
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    console.log("Shutting down OTP-aware worker pool...");

    // Clear the job queue
    this.jobQueue.forEach((job) => {
      job.reject(new Error("OTP-aware worker pool is shutting down"));
    });
    this.jobQueue = [];

    // Force release OTP
    await this.otpManager.forceReleaseOtp();

    // Terminate all workers
    const shutdownPromises = Array.from(this.workers.values()).map(
      async (activeWorker) => {
        return new Promise<void>((resolve) => {
          // Give worker a chance to finish current job
          setTimeout(() => {
            activeWorker.worker
              .terminate()
              .then(() => resolve())
              .catch(() => resolve());
          }, 5000);
        });
      }
    );

    await Promise.all(shutdownPromises);
    this.workers.clear();
    console.log("OTP-aware worker pool shutdown complete");
  }
}

// Export singleton instance
export const otpAwareWorkerPool = new OtpAwareWorkerPool();
