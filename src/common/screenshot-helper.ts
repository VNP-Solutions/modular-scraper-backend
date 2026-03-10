import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { Page } from "puppeteer";
import { jobService } from "../services/job.service.js";
import { retrievalService } from "../services/retriveal-job.service.js";
import { dualLogError, dualLogInfo } from "./log-helper.js";

/**
 * Screenshot helper utility — captures page screenshots, uploads them to S3,
 * and persists the URL to the job or retrieval document in MongoDB.
 */
export class ScreenshotHelper {
  private static readonly s3Client = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
  });

  private static readonly bucketName =
    process.env.AWS_S3_BUCKET || "vnpstorage";

  private static readonly tempDir = path.join(process.cwd(), "temp_screenshots");

  /**
   * Core screenshot method — takes a viewport screenshot, uploads to S3, and
   * saves the URL to MongoDB for the given entity (job or retrieval).
   */
  public static async takeScreenshot(
    page: Page | null,
    entityId: string,
    step: string,
    type: "step" | "error",
    platform: string = "agoda",
    entityType: "job" | "retrieval" = "job"
  ): Promise<string | null> {
    if (!page || !entityId) {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${platform}_${entityType}_${entityId}_${step}_${timestamp}.png`;
    const localPath = path.join(ScreenshotHelper.tempDir, filename);

    try {
      // Ensure temp directory exists
      if (!fs.existsSync(ScreenshotHelper.tempDir)) {
        fs.mkdirSync(ScreenshotHelper.tempDir, { recursive: true });
      }

      // Capture visible viewport only (fullPage: false)
      await page.screenshot({
        path: localPath as `${string}.png`,
        fullPage: false,
        type: "png",
      });

      // Upload to S3
      const s3Key = `screenshots/${platform}/${entityType}/${entityId}/${step}_${timestamp}.png`;
      const s3Url = await ScreenshotHelper.uploadToS3(localPath, s3Key);

      if (s3Url) {
        const entry = {
          step,
          url: s3Url,
          timestamp: new Date().toISOString(),
          type,
        };

        if (entityType === "retrieval") {
          await retrievalService.addScreenshotUrl(entityId, entry);
        } else {
          await jobService.addScreenshotUrl(entityId, entry);
        }

        await dualLogInfo(`Screenshot saved: ${step}`, {
          entityId,
          entityType,
          platform,
          s3Url,
        });
      }

      // Clean up local temp file
      try {
        fs.unlinkSync(localPath);
      } catch {
        // Non-critical; ignore cleanup errors
      }

      return s3Url;
    } catch (error: any) {
      await dualLogError("Failed to take/upload screenshot", {
        entityId,
        entityType,
        step,
        platform,
        error: error.message,
      });

      // Best-effort cleanup
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
        }
      } catch {
        // Ignore
      }

      return null;
    }
  }

  private static async uploadToS3(
    localFilePath: string,
    s3Key: string
  ): Promise<string | null> {
    try {
      const fileBuffer = fs.readFileSync(localFilePath);

      const command = new PutObjectCommand({
        Bucket: ScreenshotHelper.bucketName,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: "image/png",
      });

      await ScreenshotHelper.s3Client.send(command);

      return `https://${ScreenshotHelper.bucketName}.s3.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com/${s3Key}`;
    } catch (error: any) {
      await dualLogError("Failed to upload screenshot to S3", {
        s3Key,
        error: error.message,
      });
      return null;
    }
  }

  // ─── Legacy wrappers (keep backward-compatible for agoda.ts, need-help.ts, etc.) ─────

  public static async takeSuccessScreenshot(
    page: Page,
    jobId: string,
    stepName: string,
    platform: string = "agoda",
    options: { fullPage?: boolean; quality?: number } = {}
  ): Promise<void> {
    await ScreenshotHelper.takeScreenshot(page, jobId, stepName, "step", platform, "job");
  }

  public static async takeErrorScreenshot(
    page: Page | null,
    jobId: string,
    errorContext: string,
    platform: string = "agoda",
    options: { fullPage?: boolean; quality?: number } = {}
  ): Promise<void> {
    await ScreenshotHelper.takeScreenshot(page, jobId, errorContext, "error", platform, "job");
  }

  public static async takeCustomScreenshot(
    page: Page,
    jobId: string,
    filename: string,
    subfolder: "success" | "error" = "success",
    platform: string = "agoda",
    options: { fullPage?: boolean; quality?: number } = {}
  ): Promise<void> {
    const type = subfolder === "error" ? "error" : "step";
    await ScreenshotHelper.takeScreenshot(page, jobId, filename, type, platform, "job");
  }
}

// ─── Named exports for convenience ────────────────────────────────────────────
export const takeSuccessScreenshot =
  ScreenshotHelper.takeSuccessScreenshot.bind(ScreenshotHelper);
export const takeErrorScreenshot =
  ScreenshotHelper.takeErrorScreenshot.bind(ScreenshotHelper);
export const takeCustomScreenshot =
  ScreenshotHelper.takeCustomScreenshot.bind(ScreenshotHelper);

/**
 * Core export for direct usage with full entityType control.
 * Signature: (page, entityId, step, type, platform?, entityType?) => Promise<string | null>
 */
export const takeScreenshot = ScreenshotHelper.takeScreenshot.bind(ScreenshotHelper);
