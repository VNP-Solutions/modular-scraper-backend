import fs from "fs";
import path from "path";
import { dualLogError, dualLogInfo } from "./log-helper.js";

export interface ScreenshotManagerConfig {
  baseScreenshotDir?: string;
  jobId?: string;
  enableCleanup?: boolean;
}

export class ScreenshotManager {
  private baseScreenshotDir: string;
  private jobId?: string;
  private enableCleanup: boolean;

  constructor(config: ScreenshotManagerConfig = {}) {
    this.baseScreenshotDir =
      config.baseScreenshotDir || path.join(process.cwd(), "screenshots");
    this.jobId = config.jobId;
    this.enableCleanup = config.enableCleanup !== false; // Default to true
  }

  /**
   * Set the current job ID for screenshot organization
   */
  setJobId(jobId: string): void {
    this.jobId = jobId;
  }

  /**
   * Get the job-specific screenshot directory
   */
  getJobScreenshotDir(jobId?: string): string {
    const currentJobId = jobId || this.jobId;
    if (!currentJobId) {
      return this.baseScreenshotDir;
    }
    return path.join(this.baseScreenshotDir, currentJobId);
  }

  /**
   * Ensure the screenshot directory exists
   */
  private async ensureScreenshotDir(jobId?: string): Promise<string> {
    const screenshotDir = this.getJobScreenshotDir(jobId);

    try {
      if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
        await dualLogInfo(`📁 Created screenshot directory: ${screenshotDir}`);
      }
      return screenshotDir;
    } catch (error) {
      await dualLogError("Failed to create screenshot directory:", error);
      throw error;
    }
  }

  /**
   * Get the full path for a screenshot file
   */
  async getScreenshotPath(filename: string, jobId?: string): Promise<string> {
    const screenshotDir = await this.ensureScreenshotDir(jobId);

    // Ensure filename has .png extension
    if (!filename.endsWith(".png")) {
      filename += ".png";
    }

    return path.join(screenshotDir, filename);
  }

  /**
   * Save a screenshot with job-based organization
   */
  async saveScreenshot(
    page: any, // Puppeteer Page
    filename: string,
    jobId?: string,
    options: any = {}
  ): Promise<string> {
    try {
      const screenshotPath = await this.getScreenshotPath(filename, jobId);

      await page.screenshot({
        path: screenshotPath as `${string}.png`,
        fullPage: false,
        type: "png",
        ...options,
      });

      await dualLogInfo(`📸 Screenshot saved: ${screenshotPath}`);
      return screenshotPath;
    } catch (error) {
      await dualLogError("Failed to save screenshot:", error);
      throw error;
    }
  }

  /**
   * Generate a unique filename for captcha screenshots
   */
  generateCaptchaScreenshotName(
    prefix: string = "captcha",
    suffix?: string
  ): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const uniqueId = Math.random().toString(36).substring(2, 8);
    const parts = [prefix, timestamp, uniqueId];

    if (suffix) {
      parts.push(suffix);
    }

    return parts.join("_") + ".png";
  }

  /**
   * Generate a filename for scraping step screenshots
   */
  generateStepScreenshotName(step: string, jobId?: string): string {
    const currentJobId = jobId || this.jobId || "unknown";
    return `scraping_${step}_${currentJobId}.png`;
  }

  /**
   * Clean up job-specific screenshot directory
   */
  async cleanupJobScreenshots(
    jobId?: string,
    reason: string = "job completion"
  ): Promise<void> {
    if (!this.enableCleanup) {
      await dualLogInfo("Screenshot cleanup is disabled, skipping cleanup");
      return;
    }

    const currentJobId = jobId || this.jobId;
    if (!currentJobId) {
      await dualLogInfo("No job ID provided for screenshot cleanup");
      return;
    }

    const jobScreenshotDir = this.getJobScreenshotDir(currentJobId);

    try {
      if (fs.existsSync(jobScreenshotDir)) {
        // Get list of files before deletion for logging
        const files = fs.readdirSync(jobScreenshotDir);

        // Remove the entire job directory
        fs.rmSync(jobScreenshotDir, { recursive: true, force: true });

        await dualLogInfo(
          `🗑️ Cleaned up ${files.length} screenshots for job ${currentJobId} (${reason})`,
          {
            jobId: currentJobId,
            filesRemoved: files.length,
            directory: jobScreenshotDir,
            reason: reason,
          }
        );
      } else {
        await dualLogInfo(
          `No screenshot directory found for job ${currentJobId}`
        );
      }
    } catch (error) {
      await dualLogError(
        `Failed to cleanup screenshots for job ${currentJobId}:`,
        error
      );
    }
  }

  /**
   * Clean up all screenshots older than specified days
   */
  async cleanupOldScreenshots(daysOld: number = 7): Promise<void> {
    if (!this.enableCleanup) {
      await dualLogInfo(
        "Screenshot cleanup is disabled, skipping old screenshot cleanup"
      );
      return;
    }

    try {
      if (!fs.existsSync(this.baseScreenshotDir)) {
        return;
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const entries = fs.readdirSync(this.baseScreenshotDir, {
        withFileTypes: true,
      });
      let cleanedCount = 0;

      for (const entry of entries) {
        const fullPath = path.join(this.baseScreenshotDir, entry.name);
        const stats = fs.statSync(fullPath);

        if (stats.mtime < cutoffDate) {
          if (entry.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        await dualLogInfo(
          `🗑️ Cleaned up ${cleanedCount} old screenshot entries older than ${daysOld} days`
        );
      }
    } catch (error) {
      await dualLogError("Failed to cleanup old screenshots:", error);
    }
  }

  /**
   * List all screenshots for a specific job
   */
  async listJobScreenshots(jobId?: string): Promise<string[]> {
    const currentJobId = jobId || this.jobId;
    if (!currentJobId) {
      return [];
    }

    const jobScreenshotDir = this.getJobScreenshotDir(currentJobId);

    try {
      if (!fs.existsSync(jobScreenshotDir)) {
        return [];
      }

      const files = fs
        .readdirSync(jobScreenshotDir)
        .filter((file) => file.endsWith(".png"))
        .map((file) => path.join(jobScreenshotDir, file));

      return files;
    } catch (error) {
      await dualLogError(
        `Failed to list screenshots for job ${currentJobId}:`,
        error
      );
      return [];
    }
  }

  /**
   * Get screenshot statistics
   */
  async getScreenshotStats(): Promise<{
    totalJobs: number;
    totalScreenshots: number;
    totalSize: number;
    oldestScreenshot?: Date;
    newestScreenshot?: Date;
  }> {
    const stats = {
      totalJobs: 0,
      totalScreenshots: 0,
      totalSize: 0,
      oldestScreenshot: undefined as Date | undefined,
      newestScreenshot: undefined as Date | undefined,
    };

    try {
      if (!fs.existsSync(this.baseScreenshotDir)) {
        return stats;
      }

      const entries = fs.readdirSync(this.baseScreenshotDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        const fullPath = path.join(this.baseScreenshotDir, entry.name);

        if (entry.isDirectory()) {
          stats.totalJobs++;
          const jobFiles = fs.readdirSync(fullPath);

          for (const file of jobFiles) {
            if (file.endsWith(".png")) {
              const filePath = path.join(fullPath, file);
              const fileStats = fs.statSync(filePath);

              stats.totalScreenshots++;
              stats.totalSize += fileStats.size;

              if (
                !stats.oldestScreenshot ||
                fileStats.mtime < stats.oldestScreenshot
              ) {
                stats.oldestScreenshot = fileStats.mtime;
              }
              if (
                !stats.newestScreenshot ||
                fileStats.mtime > stats.newestScreenshot
              ) {
                stats.newestScreenshot = fileStats.mtime;
              }
            }
          }
        } else if (entry.name.endsWith(".png")) {
          // Handle screenshots in root directory
          const fileStats = fs.statSync(fullPath);
          stats.totalScreenshots++;
          stats.totalSize += fileStats.size;

          if (
            !stats.oldestScreenshot ||
            fileStats.mtime < stats.oldestScreenshot
          ) {
            stats.oldestScreenshot = fileStats.mtime;
          }
          if (
            !stats.newestScreenshot ||
            fileStats.mtime > stats.newestScreenshot
          ) {
            stats.newestScreenshot = fileStats.mtime;
          }
        }
      }
    } catch (error) {
      await dualLogError("Failed to get screenshot statistics:", error);
    }

    return stats;
  }
}

// Export a singleton instance for global use
export const screenshotManager = new ScreenshotManager();
