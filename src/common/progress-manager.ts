import fs from "fs-extra";
import path from "path";
import { JobService } from "../services/job.service.js";
import { dualLogError, dualLogInfo, dualLogWarn } from "./log-helper.js";

export interface JobProgress {
  jobId: string;
  lastProcessedDate?: string;
  progressPercentage: number;
  currentStage: string;
  resumeReason?: string;
  totalChunks?: number;
  completedChunks: number;
  startDate?: string;
  endDate?: string;
  updatedAt: Date;
}

export class ProgressManager {
  private static instance: ProgressManager;
  private progressMap: Map<string, JobProgress> = new Map();
  private progressDir: string;
  private jobService: JobService;

  private constructor() {
    // Create a progress directory for job progress files
    this.progressDir = path.join(process.cwd(), "job-progress");
    this.jobService = new JobService();
    this.ensureProgressDir();
    this.loadAllProgressFromDisk();
  }

  public static getInstance(): ProgressManager {
    if (!ProgressManager.instance) {
      ProgressManager.instance = new ProgressManager();
    }
    return ProgressManager.instance;
  }

  /**
   * Initialize progress tracking for a job
   */
  async initializeJobProgress(
    jobId: string,
    startDate: string,
    endDate: string,
    totalChunks: number
  ): Promise<void> {
    const progress: JobProgress = {
      jobId,
      startDate,
      endDate,
      totalChunks,
      progressPercentage: 0,
      currentStage: "initialized",
      completedChunks: 0,
      updatedAt: new Date(),
    };

    this.progressMap.set(jobId, progress);
    await this.saveJobProgressToDisk(jobId);

    await dualLogInfo(`Initialized progress tracking for job ${jobId}`, {
      jobId,
      startDate,
      endDate,
      totalChunks,
    });
  }

  /**
   * Update job progress
   */
  async updateJobProgress(
    jobId: string,
    lastProcessedDate?: string,
    progressPercentage?: number,
    currentStage?: string,
    completedChunks?: number
  ): Promise<void> {
    const existing = this.progressMap.get(jobId);
    if (!existing) {
      await dualLogWarn(`No progress tracking found for job ${jobId}`, {
        jobId,
      });
      return;
    }

    const updated: JobProgress = {
      ...existing,
      lastProcessedDate: lastProcessedDate ?? existing.lastProcessedDate,
      progressPercentage: progressPercentage ?? existing.progressPercentage,
      currentStage: currentStage ?? existing.currentStage,
      completedChunks: completedChunks ?? existing.completedChunks,
      updatedAt: new Date(),
    };

    this.progressMap.set(jobId, updated);
    await this.saveJobProgressToDisk(jobId);

    await dualLogInfo(`Updated progress for job ${jobId}`, {
      jobId,
      lastProcessedDate: updated.lastProcessedDate,
      progressPercentage: updated.progressPercentage,
      currentStage: updated.currentStage,
      completedChunks: updated.completedChunks,
    });
  }

  /**
   * Get job's last processed date for resume functionality
   */
  getJobLastProcessedDate(jobId: string): string | null {
    const progress = this.progressMap.get(jobId);
    return progress?.lastProcessedDate || null;
  }

  /**
   * Get job progress information
   */
  getJobProgress(jobId: string): JobProgress | null {
    return this.progressMap.get(jobId) || null;
  }

  /**
   * Set job as resumable from a specific date
   */
  async setJobResumable(
    jobId: string,
    lastProcessedDate: string,
    reason: string = "Browser restart"
  ): Promise<void> {
    const existing = this.progressMap.get(jobId);
    if (!existing) {
      await dualLogWarn(`No progress tracking found for job ${jobId}`, {
        jobId,
      });
      return;
    }

    const updated: JobProgress = {
      ...existing,
      lastProcessedDate,
      resumeReason: reason,
      currentStage: `resumable_from_${lastProcessedDate}`,
      updatedAt: new Date(),
    };

    this.progressMap.set(jobId, updated);
    await this.saveJobProgressToDisk(jobId);

    await dualLogInfo(
      `Set job ${jobId} as resumable from ${lastProcessedDate}`,
      {
        jobId,
        lastProcessedDate,
        reason,
      }
    );
  }

  /**
   * Check if job should resume from a specific date
   */
  shouldJobResume(jobId: string): {
    shouldResume: boolean;
    resumeDate?: string;
  } {
    const progress = this.progressMap.get(jobId);

    if (!progress || !progress.lastProcessedDate) {
      return { shouldResume: false };
    }

    // Check if the job was in a resumable state
    if (
      progress.currentStage?.startsWith("resumable_from_") ||
      progress.resumeReason
    ) {
      return {
        shouldResume: true,
        resumeDate: progress.lastProcessedDate,
      };
    }

    return { shouldResume: false };
  }

  /**
   * Mark job as completed and clean up progress file
   */
  async markJobCompleted(jobId: string): Promise<void> {
    await this.updateJobProgress(jobId, undefined, 100, "completed", undefined);

    // Clean up after successful completion
    await this.cleanupJobProgress(jobId);
    await dualLogInfo(
      `Job ${jobId} completed successfully. Progress file cleaned up.`,
      { jobId }
    );
  }

  /**
   * Clear job progress (useful when job is restarted from beginning)
   */
  async clearJobProgress(jobId: string): Promise<void> {
    this.progressMap.delete(jobId);
    await this.deleteJobProgressFile(jobId);

    await dualLogInfo(`Cleared progress tracking for job ${jobId}`, { jobId });
  }

  /**
   * Clean up completed job progress (delete file and remove from memory)
   */
  async cleanupJobProgress(jobId: string): Promise<void> {
    this.progressMap.delete(jobId);
    await this.deleteJobProgressFile(jobId);

    await dualLogInfo(`Cleaned up completed job progress for ${jobId}`, {
      jobId,
    });
  }

  /**
   * Mark job as failed and clean up progress file
   */
  async markJobFailed(jobId: string, error?: string): Promise<void> {
    await this.updateJobProgress(
      jobId,
      undefined,
      undefined,
      "failed",
      undefined
    );

    // Clean up after failure
    await this.cleanupJobProgress(jobId);
    await dualLogError(
      `Job ${jobId} failed and progress file cleaned up. Error: ${
        error || "Unknown error"
      }`,
      { jobId, error }
    );
  }

  /**
   * Handle job error and cleanup (called from error handlers)
   */
  async handleJobError(jobId: string, error: any): Promise<void> {
    const errorMessage = error?.message || error?.toString() || "Unknown error";

    // Check if there's any scraped data to determine status
    let status = "failed";
    try {
      const jobItemsCount = await this.jobService.getJobItemsCount(jobId);
      if (jobItemsCount > 0) {
        status = "partial";
      }
    } catch (dbError) {
      await dualLogWarn(
        `Failed to check job items count for ${jobId}, defaulting to failed status`,
        { jobId, dbError }
      );
    }

    // Update progress to failed/partial state first
    await this.updateJobProgress(
      jobId,
      undefined,
      undefined,
      status,
      undefined
    );

    // Clean up the progress file
    await this.cleanupJobProgress(jobId);

    await dualLogError(
      `Job ${jobId} encountered error and progress cleaned up: ${errorMessage}`,
      {
        jobId,
        error: errorMessage,
        finalStatus: status,
      }
    );
  }

  /**
   * Get all active job progress (for monitoring)
   */
  getAllProgress(): Map<string, JobProgress> {
    return new Map(this.progressMap);
  }

  /**
   * Get progress file path for a specific job
   */
  private getJobProgressFilePath(jobId: string): string {
    return path.join(this.progressDir, `${jobId}.json`);
  }

  /**
   * Ensure progress directory exists
   */
  private async ensureProgressDir(): Promise<void> {
    try {
      await fs.ensureDir(this.progressDir);
    } catch (error) {
      await dualLogError("Failed to create progress directory:", error);
    }
  }

  /**
   * Save progress to disk for a specific job
   */
  private async saveJobProgressToDisk(jobId: string): Promise<void> {
    try {
      const progress = this.progressMap.get(jobId);
      if (!progress) {
        return;
      }

      const progressData = {
        jobId,
        lastProcessedDate: progress.lastProcessedDate,
        progressPercentage: progress.progressPercentage,
        currentStage: progress.currentStage,
        resumeReason: progress.resumeReason,
        totalChunks: progress.totalChunks,
        completedChunks: progress.completedChunks,
        startDate: progress.startDate,
        endDate: progress.endDate,
        updatedAt: progress.updatedAt,
      };

      const filePath = this.getJobProgressFilePath(jobId);
      await fs.writeJson(filePath, progressData, { spaces: 2 });
    } catch (error) {
      await dualLogError(`Failed to save progress for job ${jobId}:`, error);
    }
  }

  /**
   * Delete progress file for a specific job
   */
  private async deleteJobProgressFile(jobId: string): Promise<void> {
    try {
      const filePath = this.getJobProgressFilePath(jobId);
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        await dualLogInfo(`Deleted progress file for job ${jobId}`, { jobId });
      }
    } catch (error) {
      await dualLogError(
        `Failed to delete progress file for job ${jobId}:`,
        error
      );
    }
  }

  /**
   * Load progress from disk for a specific job
   */
  private async loadJobProgressFromDisk(jobId: string): Promise<void> {
    try {
      const filePath = this.getJobProgressFilePath(jobId);
      if (await fs.pathExists(filePath)) {
        const progressData = await fs.readJson(filePath);

        // Validate progress data structure
        if (!progressData || typeof progressData !== "object") {
          throw new Error("Invalid progress data structure");
        }

        const { jobId: _, ...progress } = progressData;

        this.progressMap.set(jobId, {
          ...progress,
          updatedAt: new Date(progress.updatedAt || new Date()),
        });
      }
    } catch (error) {
      await dualLogError(`Failed to load progress for job ${jobId}:`, error);

      // If file is corrupted, delete it to prevent future issues
      try {
        const filePath = this.getJobProgressFilePath(jobId);
        if (await fs.pathExists(filePath)) {
          await fs.remove(filePath);
          await dualLogInfo(
            `Removed corrupted progress file for job ${jobId}`,
            { jobId }
          );
        }
      } catch (deleteError) {
        await dualLogError(
          `Failed to remove corrupted progress file for job ${jobId}:`,
          deleteError
        );
      }
    }
  }

  /**
   * Load all progress files from disk on startup
   */
  private async loadAllProgressFromDisk(): Promise<void> {
    try {
      if (await fs.pathExists(this.progressDir)) {
        const files = await fs.readdir(this.progressDir);
        const jsonFiles = files.filter((file) => file.endsWith(".json"));

        for (const file of jsonFiles) {
          const jobId = path.basename(file, ".json");
          await this.loadJobProgressFromDisk(jobId);
        }

        await dualLogInfo(
          `Loaded ${this.progressMap.size} job progress files from disk`
        );
      }
    } catch (error) {
      await dualLogError("Failed to load progress files from disk:", error);
    }
  }

  /**
   * Clean up old progress files (older than specified days)
   */
  async cleanupOldProgress(daysOld: number = 7): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      let removedCount = 0;
      const files = await fs.readdir(this.progressDir);
      const jsonFiles = files.filter((file) => file.endsWith(".json"));

      for (const file of jsonFiles) {
        const filePath = path.join(this.progressDir, file);
        const stats = await fs.stat(filePath);

        if (stats.mtime < cutoffDate) {
          const jobId = path.basename(file, ".json");
          await this.deleteJobProgressFile(jobId);
          this.progressMap.delete(jobId);
          removedCount++;
        }
      }

      if (removedCount > 0) {
        await dualLogInfo(`Cleaned up ${removedCount} old progress files`);
      }
    } catch (error) {
      await dualLogError("Failed to cleanup old progress files:", error);
    }
  }

  /**
   * Get all job progress files (for monitoring)
   */
  async getAllProgressFiles(): Promise<string[]> {
    try {
      if (await fs.pathExists(this.progressDir)) {
        const files = await fs.readdir(this.progressDir);
        return files
          .filter((file) => file.endsWith(".json"))
          .map((file) => path.basename(file, ".json"));
      }
      return [];
    } catch (error) {
      await dualLogError("Failed to get progress files:", error);
      return [];
    }
  }
}

// Export singleton instance
export const progressManager = ProgressManager.getInstance();
