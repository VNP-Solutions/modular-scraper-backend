import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { Page } from "puppeteer";
import { jobService } from "../services/job.service.js";
import { dualLogError, dualLogInfo } from "./log-helper.js";
import { OtaPlatform } from "./ota-verification-patch.js";
import { addPropertyScreenshot } from "./property-screenshot-store.js";

/**
 * Screenshot helper — takes a screenshot of the current page, uploads it to S3,
 * and appends the S3 URL to the job's screenshot_urls array in DB.
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
   * When set, screenshots are recorded on these property documents instead of
   * a Job. The property check has no Job — the id it passes around is the
   * first property's `_id` — so writing to Job would silently match nothing.
   *
   * Set for the duration of a check run and cleared in its `finally`, so the
   * screenshots already taken inside login/search are attributed correctly
   * without threading a new argument through those call sites.
   */
  private static propertyTarget: {
    runId: string;
    propertyIds: string[];
    platform: OtaPlatform;
  } | null = null;

  public static setPropertyTarget(
    runId: string,
    propertyIds: string[],
    platform: OtaPlatform = "agoda"
  ): void {
    this.propertyTarget = { runId, propertyIds, platform };
  }

  public static clearPropertyTarget(): void {
    this.propertyTarget = null;
  }

  /**
   * Core screenshot method — take screenshot, upload to S3, save URL to DB.
   *
   * @param page      Puppeteer Page instance
   * @param jobId     Job ID — used for S3 path and DB update
   * @param step      Human-readable step name, e.g. "login_completed"
   * @param type      "step" for normal flow, "error" for error captures
   * @param platform  Optional platform label (default "agoda")
   * @returns         S3 URL string, or null if anything failed
   */
  public static async takeScreenshot(
    page: Page | null,
    jobId: string,
    step: string,
    type: "step" | "error",
    platform: string = "agoda"
  ): Promise<string | null> {
    const target = this.propertyTarget;
    if (target) {
      return this.takeScreenshotForProperties(
        page,
        target.runId,
        target.propertyIds,
        step,
        type,
        target.platform
      );
    }

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
      await fs.mkdir(localDir, { recursive: true });

      await page.screenshot({
        path: localPath as `${string}.png`,
        fullPage: false,
        type: "png",
      });

      const s3Url = await this.uploadToS3(localPath, jobId, type, filename);

      // Clean up local file regardless of S3 outcome
      await fs.unlink(localPath).catch(() => {});

      if (s3Url) {
        const entry = {
          step,
          url: s3Url,
          timestamp: new Date().toISOString(),
          type,
        };

        await jobService.addScreenshotUrl(jobId, entry);

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
      await fs.unlink(localPath).catch(() => {});
      return null;
    }
  }

  /**
   * Take a screenshot, upload it to S3 once, and record the resulting URL on
   * every given property.
   *
   * The property check has no Job to hang screenshots off, so this is the
   * property-side counterpart of {@link takeScreenshot}. Account-level captures
   * (login, OTP) happen before any single property is identified, so one upload
   * is shared by all properties in the run rather than duplicated.
   *
   * Never throws: screenshot failures must not interrupt the check.
   */
  public static async takeScreenshotForProperties(
    page: Page | null,
    runId: string,
    propertyIds: string[],
    step: string,
    type: "step" | "error",
    platform: OtaPlatform = "agoda"
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
    jobId: string,
    type: "step" | "error",
    filename: string
  ): Promise<string | null> {
    return this.uploadKeyToS3(
      localPath,
      `job-screenshots/${jobId}/${type}/${filename}`,
      { jobId }
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

/**
 * Takes a "step" (success) screenshot.
 * Used throughout agoda.ts and agoda/login-system/login.ts
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
 * Takes an "error" screenshot.
 * Used throughout agoda.ts and agoda/login-system/login.ts
 */
export async function takeErrorScreenshot(
  page: Page | null,
  jobId: string,
  errorContext: string,
  platform: string = "agoda"
): Promise<string | null> {
  return ScreenshotHelper.takeScreenshot(
    page,
    jobId,
    errorContext,
    "error",
    platform
  );
}

export const takeScreenshot = ScreenshotHelper.takeScreenshot.bind(
  ScreenshotHelper
);
