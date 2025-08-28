import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import {
  WorkerInfo,
  WorkerJobData,
  WorkerMessage,
  WorkerMessageType,
  WorkerPoolConfig,
  WorkerPoolStatus,
  WorkerResponse,
} from "./worker-types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ActiveWorker {
  worker: Worker;
  info: WorkerInfo;
  resolve?: (value: WorkerResponse) => void;
  reject?: (reason: any) => void;
}

export class WorkerPool extends EventEmitter {
  private workers: Map<string, ActiveWorker> = new Map();
  private jobQueue: Array<{
    jobData: WorkerJobData;
    resolve: (value: WorkerResponse) => void;
    reject: (reason: any) => void;
  }> = [];
  private config: WorkerPoolConfig;
  private isShuttingDown = false;

  constructor(config: Partial<WorkerPoolConfig> = {}) {
    super();

    this.config = {
      maxWorkers:
        config.maxWorkers || parseInt(process.env.MAX_WORKER_THREADS || "3"),
      queueSize:
        config.queueSize || parseInt(process.env.WORKER_QUEUE_SIZE || "10"),
    };

    console.log(`Worker pool initialized with config:`, this.config);
    this.initializeWorkers();
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

      console.log(`Creating worker with path: ${workerPath}`);

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
        console.error(`Worker ${workerId} error:`, error);
        this.handleWorkerError(workerId, error);
      });

      // Handle worker exit
      worker.on("exit", (code) => {
        console.log(`Worker ${workerId} exited with code ${code}`);
        this.handleWorkerExit(workerId, code);
      });

      this.workers.set(workerId, activeWorker);
      console.log(`Worker ${workerId} created and ready`);

      this.emit("workerReady", workerId);
    } catch (error) {
      console.error(`Failed to create worker ${workerId}:`, error);
    }
  }

  private handleWorkerMessage(workerId: string, message: WorkerMessage): void {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

    activeWorker.info.lastActivity = new Date();

    switch (message.type) {
      case WorkerMessageType.JobStart:
        console.log(`Worker ${workerId} started job ${message.jobId}`);
        this.emit("jobStart", {
          workerId,
          jobId: message.jobId,
          data: message.data,
        });
        break;

      case WorkerMessageType.JobProgress:
        console.log(
          `Worker ${workerId} progress for job ${message.jobId}:`,
          message.data
        );
        this.emit("jobProgress", {
          workerId,
          jobId: message.jobId,
          data: message.data,
        });
        break;

      case WorkerMessageType.JobComplete:
        console.log(`Worker ${workerId} completed job ${message.jobId}`);
        this.handleJobComplete(workerId, message);
        break;

      case WorkerMessageType.JobError:
        console.error(
          `Worker ${workerId} error for job ${message.jobId}:`,
          message.data
        );
        this.handleJobError(workerId, message);
        break;

      case WorkerMessageType.JobLog:
        console.log(
          `Worker ${workerId} log for job ${message.jobId}:`,
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

  private handleJobError(workerId: string, message: WorkerMessage): void {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

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

  private handleWorkerError(workerId: string, error: Error): void {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

    console.error(`Worker ${workerId} encountered an error:`, error);

    // Reject current job if any
    if (activeWorker.reject) {
      activeWorker.reject(new Error(`Worker error: ${error.message}`));
    }

    // Recreate the worker
    this.recreateWorker(workerId);
  }

  private handleWorkerExit(workerId: string, code: number): void {
    const activeWorker = this.workers.get(workerId);
    if (!activeWorker) return;

    console.log(`Worker ${workerId} exited with code ${code}`);

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
          console.error(`Error terminating worker ${workerId}:`, error);
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
      console.error(`Error recreating worker ${workerId}:`, error);
    }
  }

  public async executeJob(jobData: WorkerJobData): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      // Check if queue is full
      if (this.jobQueue.length >= this.config.queueSize) {
        reject(new Error("Job queue is full"));
        return;
      }

      // Try to assign job immediately
      const availableWorker = this.getAvailableWorker();
      if (availableWorker) {
        this.assignJobToWorker(availableWorker, jobData, resolve, reject);
      } else {
        // Add to queue
        this.jobQueue.push({ jobData, resolve, reject });
        console.log(
          `Job ${jobData.jobId} queued. Queue size: ${this.jobQueue.length}`
        );
      }
    });
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
      console.log(`Job ${jobData.jobId} assigned to worker ${workerId}`);
    } catch (error) {
      console.error(`Error sending job to worker ${workerId}:`, error);
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
    if (this.jobQueue.length === 0) return;

    const availableWorker = this.getAvailableWorker();
    if (availableWorker) {
      const queuedJob = this.jobQueue.shift();
      if (queuedJob) {
        console.log(
          `Processing queued job ${queuedJob.jobData.jobId}. Queue size: ${this.jobQueue.length}`
        );
        this.assignJobToWorker(
          availableWorker,
          queuedJob.jobData,
          queuedJob.resolve,
          queuedJob.reject
        );
      }
    }
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
      // Send stop message to worker first (if worker supports it)
      targetWorker.worker.postMessage({ type: "stop", jobId });

      // Give worker a moment to handle stop gracefully
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Terminate the worker and recreate it
      await targetWorker.worker.terminate();
      console.log(`Worker ${targetWorkerId} terminated for job ${jobId}`);

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
        `Job ${jobId} stopped and worker ${targetWorkerId} recreated`
      );
      return true;
    } catch (error) {
      console.error(`Error stopping job ${jobId}:`, error);
      return false;
    }
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    console.log("Shutting down worker pool...");

    // Clear the job queue
    this.jobQueue.forEach((job) => {
      job.reject(new Error("Worker pool is shutting down"));
    });
    this.jobQueue = [];

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
    console.log("Worker pool shutdown complete");
  }
}

// Export singleton instance
export const workerPool = new WorkerPool();
