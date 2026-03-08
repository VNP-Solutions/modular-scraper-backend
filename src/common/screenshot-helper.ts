import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { Page } from "puppeteer";
import { jobService } from "../services/job.service.js";
import { dualLogError, dualLogInfo } from "./log-helper.js";

/**
 * Screenshot helper — takes a screenshot of the current page, uploads it to S3,
 * and appends the S3 URL to the job or retrieval's screenshot_urls array in DB.
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

  private static s3BucketName = process.env.S3_BUCKET_NAME || "vnpstorage";

  private static get baseDir(): string {
    return path.join(process.cwd(), "screenshots");
  }

  /**
   * Take a screenshot, upload to S3, and save the URL to the correct DB record.
   *
   * @param page        Puppeteer Page instance
   * @param entityId    Job ID or Retrieval ID
   * @param step        Human-readable step name, e.g. "login_page_loaded"
   * @param type        "step" for normal flow, "error" for error captures
   * @param platform    Optional platform label (default "expedia")
   * @param entityType  "job" (default) — which DB record to update
   * @returns           S3 URL string, or null if anything failed
   */
  public static async takeScreenshot(
    page: Page | null,
    entityId: string,
    step: string,
    type: "step" | "error",
    platform: string = "expedia",
    entityType: "job" | "retrieval" = "job"
  ): Promise<string | null> {
    if (!page || !entityId) {
      await dualLogError("takeScreenshot: missing page or entityId", {
        hasPage: !!page,
        entityId,
        step,
      });
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${step}_${timestamp}.png`;
    const localDir = path.join(
      this.baseDir,
      platform,
      entityId,
      type === "error" ? "error" : "step"
    );
    const localPath = path.join(localDir, filename);

    try {
      await fs.mkdir(localDir, { recursive: true });

      await page.screenshot({
        path: localPath as `${string}.png`,
        fullPage: true,
        type: "png",
      });

      const s3Url = await this.uploadToS3(localPath, entityId, type, filename);

      // Clean up local file regardless of S3 outcome
      await fs.unlink(localPath).catch(() => {});

      if (s3Url) {
        const entry = {
          step,
          url: s3Url,
          timestamp: new Date().toISOString(),
          type,
        };

        // On this branch only jobs exist — entityType "retrieval" is a no-op fallback
        await jobService.addScreenshotUrl(entityId, entry);

        await dualLogInfo(`Screenshot captured: ${step}`, {
          entityId,
          entityType,
          platform,
          step,
          type,
          s3Url,
        });

        return s3Url;
      }

      await dualLogError(`Screenshot S3 upload failed for step: ${step}`, {
        entityId,
        step,
      });
      return null;
    } catch (error: any) {
      await dualLogError(`Failed to take screenshot for step: ${step}`, {
        entityId,
        step,
        type,
        error: error.message,
      });
      await fs.unlink(localPath).catch(() => {});
      return null;
    }
  }

  private static async uploadToS3(
    localPath: string,
    entityId: string,
    type: "step" | "error",
    filename: string
  ): Promise<string | null> {
    try {
      const fileContent = await fs.readFile(localPath);
      const s3Key = `job-screenshots/${entityId}/${type}/${filename}`;

      const command = new PutObjectCommand({
        Bucket: this.s3BucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: "image/png",
        Metadata: {
          entityId,
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
 */
export async function takeErrorScreenshot(
  page: Page | null,
  jobId: string,
  errorContext: string,
  platform: string = "agoda"
): Promise<string | null> {
  return ScreenshotHelper.takeScreenshot(page, jobId, errorContext, "error", platform);
}
