import fs from "fs";
import path from "path";
import { Page } from "puppeteer";
import { dualLogInfo, dualLogError } from "./log-helper.js";

/**
 * Screenshot helper utility for taking and organizing screenshots
 * during job execution with organized folder structure
 */
export class ScreenshotHelper {
  private static baseScreenshotsDir = "screenshots";

  /**
   * Ensures the screenshot folder structure exists
   * screenshots/agoda/{jobId}/success/
   * screenshots/agoda/{jobId}/error/
   */
  private static async ensureFolderStructure(
    jobId: string,
    platform: string = "agoda"
  ): Promise<{
    successDir: string;
    errorDir: string;
  }> {
    const baseDir = path.join(this.baseScreenshotsDir, platform, jobId);
    const successDir = path.join(baseDir, "success");
    const errorDir = path.join(baseDir, "error");

    // Create directories if they don't exist
    // TEMPORARILY DISABLED - Folder creation commented out
    // await fs.promises.mkdir(successDir, { recursive: true });
    // await fs.promises.mkdir(errorDir, { recursive: true });

    return { successDir, errorDir };
  }

  /**
   * Takes a success screenshot after a step is completed successfully
   */
  public static async takeSuccessScreenshot(
    page: Page,
    jobId: string,
    stepName: string,
    platform: string = "agoda",
    options: {
      fullPage?: boolean;
      quality?: number;
    } = {}
  ): Promise<void> {
    try {
      if (!page || !jobId) {
        await dualLogError("Cannot take screenshot: missing page or jobId", {
          hasPage: !!page,
          jobId,
        });
        return;
      }

      const { successDir } = await this.ensureFolderStructure(jobId, platform);

      // Generate timestamp for unique filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${stepName}_${timestamp}.png`;
      const screenshotPath = path.join(successDir, filename);

      // Take screenshot with default options
      // TEMPORARILY DISABLED - Screenshot saving commented out
      // await page.screenshot({
      //   path: screenshotPath as `${string}.png`,
      //   fullPage: options.fullPage ?? true,
      //   type: "png",
      //   quality: options.quality,
      // });

      await dualLogInfo(`Success screenshot taken: ${stepName}`, {
        jobId,
        platform,
        stepName,
        screenshotPath,
        timestamp,
      });
    } catch (error: any) {
      await dualLogError("Failed to take success screenshot", {
        jobId,
        stepName,
        platform,
        error: error.message,
      });
      // Don't throw error - screenshots shouldn't break the main process
    }
  }

  /**
   * Takes an error screenshot when an error occurs
   */
  public static async takeErrorScreenshot(
    page: Page | null,
    jobId: string,
    errorContext: string,
    platform: string = "agoda",
    options: {
      fullPage?: boolean;
      quality?: number;
    } = {}
  ): Promise<void> {
    try {
      if (!page || !jobId) {
        await dualLogError(
          "Cannot take error screenshot: missing page or jobId",
          {
            hasPage: !!page,
            jobId,
          }
        );
        return;
      }

      const { errorDir } = await this.ensureFolderStructure(jobId, platform);

      // Generate timestamp for unique filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `error_${errorContext}_${timestamp}.png`;
      const screenshotPath = path.join(errorDir, filename);

      // Take screenshot with default options
      // TEMPORARILY DISABLED - Screenshot saving commented out
      // await page.screenshot({
      //   path: screenshotPath as `${string}.png`,
      //   fullPage: options.fullPage ?? true,
      //   type: "png",
      //   quality: options.quality,
      // });

      await dualLogInfo(`Error screenshot taken: ${errorContext}`, {
        jobId,
        platform,
        errorContext,
        screenshotPath,
        timestamp,
      });
    } catch (error: any) {
      await dualLogError("Failed to take error screenshot", {
        jobId,
        errorContext,
        platform,
        error: error.message,
      });
      // Don't throw error - screenshots shouldn't break the main process
    }
  }

  /**
   * Takes a screenshot with custom naming and folder
   */
  public static async takeCustomScreenshot(
    page: Page,
    jobId: string,
    filename: string,
    subfolder: "success" | "error" = "success",
    platform: string = "agoda",
    options: {
      fullPage?: boolean;
      quality?: number;
    } = {}
  ): Promise<void> {
    try {
      if (!page || !jobId) {
        await dualLogError(
          "Cannot take custom screenshot: missing page or jobId",
          {
            hasPage: !!page,
            jobId,
          }
        );
        return;
      }

      const { successDir, errorDir } = await this.ensureFolderStructure(
        jobId,
        platform
      );
      const targetDir = subfolder === "success" ? successDir : errorDir;

      // Add timestamp if not already in filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const finalFilename = filename.includes(timestamp)
        ? filename
        : `${filename}_${timestamp}.png`;
      const screenshotPath = path.join(targetDir, finalFilename);

      // Take screenshot
      // TEMPORARILY DISABLED - Screenshot saving commented out
      // await page.screenshot({
      //   path: screenshotPath as `${string}.png`,
      //   fullPage: options.fullPage ?? true,
      //   type: "png",
      //   quality: options.quality,
      // });

      await dualLogInfo(`Custom screenshot taken: ${filename}`, {
        jobId,
        platform,
        filename: finalFilename,
        subfolder,
        screenshotPath,
        timestamp,
      });
    } catch (error: any) {
      await dualLogError("Failed to take custom screenshot", {
        jobId,
        filename,
        platform,
        subfolder,
        error: error.message,
      });
      // Don't throw error - screenshots shouldn't break the main process
    }
  }

  /**
   * Cleanup old screenshots for a specific job (optional utility)
   */
  public static async cleanupOldScreenshots(
    jobId: string,
    platform: string = "agoda",
    maxAge: number = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
  ): Promise<void> {
    try {
      const baseDir = path.join(this.baseScreenshotsDir, platform, jobId);

      if (!fs.existsSync(baseDir)) {
        return;
      }

      const now = Date.now();
      const directories = ["success", "error"];

      for (const dir of directories) {
        const dirPath = path.join(baseDir, dir);
        if (fs.existsSync(dirPath)) {
          const files = await fs.promises.readdir(dirPath);

          for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = await fs.promises.stat(filePath);

            if (now - stats.mtime.getTime() > maxAge) {
              await fs.promises.unlink(filePath);
              await dualLogInfo(`Cleaned up old screenshot: ${file}`, {
                jobId,
                platform,
                filePath,
              });
            }
          }
        }
      }
    } catch (error: any) {
      await dualLogError("Failed to cleanup old screenshots", {
        jobId,
        platform,
        error: error.message,
      });
    }
  }
}

// Export convenience functions
export const takeSuccessScreenshot =
  ScreenshotHelper.takeSuccessScreenshot.bind(ScreenshotHelper);
export const takeErrorScreenshot =
  ScreenshotHelper.takeErrorScreenshot.bind(ScreenshotHelper);
export const takeCustomScreenshot =
  ScreenshotHelper.takeCustomScreenshot.bind(ScreenshotHelper);
export const cleanupOldScreenshots =
  ScreenshotHelper.cleanupOldScreenshots.bind(ScreenshotHelper);
