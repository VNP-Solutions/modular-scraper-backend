import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { Page } from "puppeteer";
import { jobService } from "../services/job.service.js";
import { dualLogError, dualLogInfo } from "./log-helper.js";

/**
 * Screenshot helper — takes a screenshot of the current page, uploads it to S3,
 * and appends the S3 URL to the job's screenshot_urls array in the database.
 *
 * Never throws: screenshot failures must not interrupt the scraping process.
 */
export class ScreenshotHelper {
  private static s3Client = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
  });

  private static s3BucketName =
    process.env.S3_BUCKET_NAME || "vnpstorage";

  private static get baseDir(): string {
    return path.join(process.cwd(), "screenshots");
  }

  /**
   * Take a screenshot, upload to S3, and save the URL to the job record.
   *
   * @param page     Puppeteer Page instance
   * @param jobId    Job ID — used for S3 path and DB update
   * @param step     Human-readable step name, e.g. "login_page_loaded"
   * @param type     "step" for normal flow, "error" for error captures
   * @param platform Optional platform label (default "expedia")
   * @returns        S3 URL string, or null if anything failed
   */
  public static async takeScreenshot(
    page: Page | null,
    jobId: string,
    step: string,
    type: "step" | "error",
    platform: string = "expedia"
  ): Promise<string | null> {
    if (!page || !jobId) {
      await dualLogError("takeScreenshot: missing page or jobId", {
        hasPage: !!page,
        jobId,
        step,
      });
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${step}_${timestamp}.png`;
    const localDir = path.join(
      this.baseDir,
      platform,
      jobId,
      type === "error" ? "error" : "step"
    );
    const localPath = path.join(localDir, filename);

    try {
      // Ensure local directory exists
      await fs.mkdir(localDir, { recursive: true });

      // Take screenshot and save locally first
      await page.screenshot({
        path: localPath as `${string}.png`,
        fullPage: true,
        type: "png",
      });

      // Upload to S3
      const s3Url = await this.uploadToS3(
        localPath,
        jobId,
        type,
        filename
      );

      // Clean up local file regardless of S3 outcome
      await fs.unlink(localPath).catch(() => {
        // ignore cleanup errors
      });

      if (s3Url) {
        // Persist URL in the job document
        await jobService.addScreenshotUrl(jobId, {
          step,
          url: s3Url,
          timestamp: new Date().toISOString(),
          type,
        });

        await dualLogInfo(`Screenshot captured: ${step}`, {
          jobId,
          platform,
          step,
          type,
          s3Url,
        });

        return s3Url;
      }

      await dualLogError(`Screenshot S3 upload failed for step: ${step}`, {
        jobId,
        step,
      });
      return null;
    } catch (error: any) {
      await dualLogError(`Failed to take screenshot for step: ${step}`, {
        jobId,
        step,
        type,
        error: error.message,
      });
      // Clean up local file if it exists
      await fs.unlink(localPath).catch(() => {});
      return null;
    }
  }

  private static async uploadToS3(
    localPath: string,
    jobId: string,
    type: "step" | "error",
    filename: string
  ): Promise<string | null> {
    try {
      const fileContent = await fs.readFile(localPath);
      const s3Key = `job-screenshots/${jobId}/${type}/${filename}`;

      const command = new PutObjectCommand({
        Bucket: this.s3BucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: "image/png",
        Metadata: {
          jobId,
          uploadedAt: new Date().toISOString(),
        },
      });

      await this.s3Client.send(command);

      return `https://${this.s3BucketName}.s3.${
        process.env.AWS_REGION || "us-east-1"
      }.amazonaws.com/${s3Key}`;
    } catch (error: any) {
      console.error("Failed to upload screenshot to S3:", error);
      return null;
    }
  }
}

export const takeScreenshot = ScreenshotHelper.takeScreenshot.bind(
  ScreenshotHelper
);

/**
 * Backward-compatible wrapper: takes a "step" screenshot (success).
 * Maps the old (page, jobId, stepName, platform?) signature to the new API.
 */
export async function takeSuccessScreenshot(
  page: Page | null,
  jobId: string,
  stepName: string,
  platform: string = "agoda"
): Promise<string | null> {
  return ScreenshotHelper.takeScreenshot(page, jobId, stepName, "step", platform);
}

/**
 * Backward-compatible wrapper: takes an "error" screenshot.
 * Maps the old (page, jobId, errorContext, platform?) signature to the new API.
 */
export async function takeErrorScreenshot(
  page: Page | null,
  jobId: string,
  errorContext: string,
  platform: string = "agoda"
): Promise<string | null> {
  return ScreenshotHelper.takeScreenshot(page, jobId, errorContext, "error", platform);
}
