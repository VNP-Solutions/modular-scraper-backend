import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { Page } from "puppeteer";
import { jobService } from "../services/job.service.js";
import { dualLogError, dualLogInfo } from "./log-helper.js";
import { OtaPlatform } from "./ota-verification-patch.js";
import { addPropertyScreenshot } from "./property-screenshot-store.js";

export interface PropertyScreenshotContext {
  runId: string;
  propertyIds: string[];
  platform: OtaPlatform;
}

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

  /**
   * Property-check runs have no Job ID. Login/OTP still call takeScreenshot
   * with an empty entityId; this context lets those captures go to the same
   * property-screenshot S3/DB path as login_complete / otp_complete.
   */
  private static propertyContext: PropertyScreenshotContext | null = null;

  public static setPropertyScreenshotContext(
    context: PropertyScreenshotContext | null
  ): void {
    this.propertyContext = context;
  }

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
    if (!page) {
      await dualLogError("takeScreenshot: missing page or entityId", {
        hasPage: false,
        entityId,
        step,
      });
      return null;
    }

    if (!entityId) {
      const ctx = this.propertyContext;
      if (ctx?.runId && ctx.propertyIds.length > 0) {
        return this.takeScreenshotForProperties(
          page,
          ctx.runId,
          ctx.propertyIds,
          step,
          type,
          ctx.platform
        );
      }

      await dualLogError("takeScreenshot: missing page or entityId", {
        hasPage: true,
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

  /**
   * Take a screenshot, upload it to S3 once, and record the resulting URL on
   * every given property.
   *
   * The property check runs without a Job, so this is the property-side
   * counterpart of {@link takeScreenshot}. Account-level captures (login, OTP)
   * happen before any single property is identified, so one upload is shared
   * by all properties in the run rather than duplicated per property.
   *
   * Never throws: screenshot failures must not interrupt the check.
   */
  public static async takeScreenshotForProperties(
    page: Page | null,
    runId: string,
    propertyIds: string[],
    step: string,
    type: "step" | "error",
    platform: OtaPlatform = "expedia"
  ): Promise<string | null> {
    if (!page || !runId || propertyIds.length === 0) {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${step}_${timestamp}.png`;
    const localDir = path.join(
      this.baseDir,
      platform,
      runId,
      type === "error" ? "error" : "step"
    );
    const localPath = path.join(localDir, filename);

    try {
      await fs.mkdir(localDir, { recursive: true });

      await page.screenshot({
        path: localPath as `${string}.png`,
        fullPage: false,
        type: "png",
      });

      const s3Key = `property-screenshots/${runId}/${type}/${filename}`;
      const s3Url = await this.uploadKeyToS3(localPath, s3Key, {
        runId,
        propertyCount: String(propertyIds.length),
      });

      // Clean up local file regardless of S3 outcome
      await fs.unlink(localPath).catch(() => {});

      if (!s3Url) {
        await dualLogError(
          `Property screenshot S3 upload failed for step: ${step}`,
          { runId, step }
        );
        return null;
      }

      await addPropertyScreenshot(platform, propertyIds, {
        step,
        url: s3Url,
        timestamp: new Date().toISOString(),
        type,
      });

      await dualLogInfo(`Screenshot captured: ${step}`, {
        runId,
        platform,
        step,
        type,
        s3Url,
        properties: propertyIds.length,
      });

      return s3Url;
    } catch (error: any) {
      await dualLogError(
        `Failed to take property screenshot for step: ${step}`,
        { runId, step, type, error: error.message }
      );
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
    return this.uploadKeyToS3(
      localPath,
      `job-screenshots/${entityId}/${type}/${filename}`,
      { entityId }
    );
  }

  /** Uploads one local PNG to the given S3 key and returns its public URL. */
  private static async uploadKeyToS3(
    localPath: string,
    s3Key: string,
    metadata: Record<string, string> = {}
  ): Promise<string | null> {
    try {
      const fileContent = await fs.readFile(localPath);

      const command = new PutObjectCommand({
        Bucket: this.s3BucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: "image/png",
        Metadata: {
          ...metadata,
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
