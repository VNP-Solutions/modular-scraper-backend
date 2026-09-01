/**
 * Archives the CSV attached during Agoda Need Help, and holds the S3 URL in
 * memory until the job actually reaches Completed. Partial / Failed / Stopped
 * must not persist the URL on the job.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { dualLogInfo, dualLogWarn } from "./log-helper.js";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const bucketName = process.env.S3_BUCKET_NAME || "vnpstorage";

const pendingNeedHelpFileUrls = new Map<string, string>();

function sanitizeFilename(filename: string): string {
  const cleaned = filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "need-help.csv";
}

export function setPendingNeedHelpFileUrl(jobId: string, url: string): void {
  pendingNeedHelpFileUrls.set(jobId, url);
}

/**
 * Returns the pending Need Help S3 URL for this job and removes it from
 * memory so it cannot be written twice or leak across runs.
 */
export function takePendingNeedHelpFileUrl(jobId: string): string | undefined {
  const url = pendingNeedHelpFileUrls.get(jobId);
  pendingNeedHelpFileUrls.delete(jobId);
  return url;
}

export function buildNeedHelpFileS3Key(
  jobId: string,
  filename: string
): string {
  return `need-help-files/${jobId}/${sanitizeFilename(filename)}`;
}

/**
 * Uploads the Need Help CSV to S3. Never throws: a failed archive must not
 * fail the property run. Returns the public URL, or null if upload failed.
 */
export async function uploadNeedHelpCsvToS3(
  jobId: string,
  filePath: string
): Promise<string | null> {
  const filename = path.basename(filePath);
  const s3Key = buildNeedHelpFileS3Key(jobId, filename);

  try {
    const body = await fs.readFile(filePath);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: body,
        ContentType: "text/csv",
        Metadata: {
          jobId,
          uploadedAt: new Date().toISOString(),
        },
      })
    );

    const s3Url = `https://${bucketName}.s3.${
      process.env.AWS_REGION || "us-east-1"
    }.amazonaws.com/${s3Key}`;

    await dualLogInfo(`☁️ Uploaded Need Help CSV to S3`, {
      jobId,
      filename,
      s3Key,
    });

    return s3Url;
  } catch (error: any) {
    await dualLogWarn(`⚠️ Failed to upload Need Help CSV to S3`, {
      jobId,
      s3Key,
      error: error?.message || String(error),
    });
    return null;
  }
}
