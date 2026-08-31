import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { Page } from "puppeteer";
import { jobService } from "../services/job.service.js";
import { dualLogError, dualLogInfo } from "./log-helper.js";

/** Which job field a run's screenshots are recorded against. */
export type ScreenshotTarget = "screenshot_urls" | "case_opening_screenshot";

/**
 * Per-job screenshot destination. Login and Need Help are shared by the
 * property run and the reopen run and capture screenshots deep inside their own
 * call stacks, so the destination is registered once per run rather than
 * threaded through every call. Keyed by job ID, so concurrent jobs stay
 * independent.
 */
const screenshotTargets = new Map<string, ScreenshotTarget>();

export function setScreenshotTarget(
  jobId: string,
  target: ScreenshotTarget
): void {
  screenshotTargets.set(jobId, target);
}

export function clearScreenshotTarget(jobId: string): void {
  screenshotTargets.delete(jobId);
}

/**
 * Screenshot helper — takes a screenshot of the current page, uploads it to S3,
 * and appends the S3 URL to the job's screenshot array in DB. Which array is
 * decided by `setScreenshotTarget`, defaulting to `screenshot_urls`.
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

      const target = screenshotTargets.get(jobId) ?? "screenshot_urls";

      const s3Url = await this.uploadToS3(
        localPath,
        jobId,
        type,
        filename,
        target
      );

      // Clean up local file regardless of S3 outcome
      await fs.unlink(localPath).catch(() => {});

      if (s3Url) {
        const entry = {
          step,
          url: s3Url,
          timestamp: new Date().toISOString(),
          type,
        };

        if (target === "case_opening_screenshot") {
          await jobService.addCaseOpeningScreenshotUrl(jobId, entry);
        } else {
          await jobService.addScreenshotUrl(jobId, entry);
        }

        await dualLogInfo(`Screenshot captured: ${step}`, {
          jobId,
          platform,
          step,
          type,
          target,
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

  private static async uploadToS3(
    localPath: string,
    jobId: string,
    type: "step" | "error",
    filename: string,
    target: ScreenshotTarget = "screenshot_urls"
  ): Promise<string | null> {
    try {
      const fileContent = await fs.readFile(localPath);
      const prefix =
        target === "case_opening_screenshot"
          ? `job-screenshots/${jobId}/case-opening`
          : `job-screenshots/${jobId}`;
      const s3Key = `${prefix}/${type}/${filename}`;

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

/**
 * Takes a "step" (success) screenshot.
 * Used throughout agoda.ts, agoda/login-system/login.ts, agoda/booking-data/booking-data.ts
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
 * Used throughout agoda.ts, agoda/login-system/login.ts, agoda/booking-data/booking-data.ts
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
