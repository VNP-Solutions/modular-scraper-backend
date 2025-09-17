import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import { Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "./log-helper.js";

dotenv.config();

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const S3_BUCKET_NAME = process.env.AWS_S3_BUCKET as string;

const s3Client = new S3Client({ region: AWS_REGION });

let screenshotCounter = 0;

/**
 * Takes a screenshot of the current page and uploads it to S3
 * Only works for Agoda scraping platform
 * @param page - Puppeteer page instance
 * @param jobId - Job ID for organizing screenshots
 * @param stepName - Name of the current step/page for identification
 * @param platform - Platform name (should be 'agoda' for this function)
 * @returns Promise<string | null> - S3 URL of uploaded screenshot or null if failed
 */
export async function captureAndUploadAgodaScreenshot(
  page: Page,
  jobId: string,
  stepName: string,
  platform?: string
): Promise<string | null> {
  // Only capture screenshots for Agoda platform
  if (platform && platform !== "agoda") {
    return null;
  }

  if (!S3_BUCKET_NAME) {
    await dualLogError("S3 bucket not configured; skipping screenshot upload", {
      jobId,
      stepName,
    });
    return null;
  }

  try {
    // Increment counter for unique filenames
    screenshotCounter++;

    // Generate timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // Create filename with counter, timestamp, and step name
    const filename = `agoda-screenshot-${screenshotCounter}-${timestamp}-${stepName}.png`;

    // Take screenshot
    await dualLogInfo(`📸 Taking Agoda screenshot: ${stepName}`, {
      jobId,
      stepName,
      screenshotNumber: screenshotCounter,
    });

    const screenshotBuffer = await page.screenshot({
      fullPage: true,
      type: "png",
    });

    // Upload to S3
    const s3Key = `agoda-screenshots/${jobId}/${filename}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: s3Key,
      Body: screenshotBuffer,
      ContentType: "image/png",
      Metadata: {
        jobId: jobId,
        stepName: stepName,
        platform: "agoda",
        screenshotNumber: screenshotCounter.toString(),
        capturedAt: new Date().toISOString(),
      },
    });

    await s3Client.send(command);

    // Generate S3 URL
    const s3Url = `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`;

    // Log success with colored output
    console.log(`\x1b[32m📸 Agoda Screenshot uploaded to S3: ${s3Url}\x1b[0m`);

    await dualLogInfo(`✅ Agoda screenshot uploaded successfully`, {
      jobId,
      stepName,
      s3Url,
      screenshotNumber: screenshotCounter,
      s3Key,
    });

    return s3Url;
  } catch (error: any) {
    await dualLogError("Failed to capture and upload Agoda screenshot", error, {
      jobId,
      stepName,
      screenshotNumber: screenshotCounter,
    });
    return null;
  }
}

/**
 * Reset screenshot counter (useful for new jobs)
 */
export function resetAgodaScreenshotCounter(): void {
  screenshotCounter = 0;
}

/**
 * Get current screenshot counter value
 */
export function getAgodaScreenshotCounter(): number {
  return screenshotCounter;
}
