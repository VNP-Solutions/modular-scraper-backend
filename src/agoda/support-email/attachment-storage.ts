/**
 * Archives the original CSV / XLSX files Agoda Partner Support attaches to its
 * replies, so the raw report stays available after parsing.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { dualLogInfo, dualLogWarn } from "../../common/log-helper.js";
import type { AttachmentFormat } from "./support-email.types.js";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const bucketName = process.env.S3_BUCKET_NAME || "vnpstorage";

export interface AttachmentUploadResult {
  s3Url: string | null;
  s3Key: string | null;
  uploadError?: string;
}

export interface AttachmentUploadInput {
  agodaId: string | null | undefined;
  messageId: string;
  filename: string;
  mimeType: string;
  format: AttachmentFormat;
  buffer: Buffer;
}

/** Keeps the key readable while staying inside S3's safe character set. */
function sanitizeFilename(filename: string): string {
  const cleaned = filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "attachment";
}

function contentTypeFor(mimeType: string, format: AttachmentFormat): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  if (format === "csv") return "text/csv";
  if (format === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "application/octet-stream";
}

/**
 * The key is derived only from the Gmail message and the filename, so a message
 * seen again in a later run overwrites its own object instead of piling up
 * copies, and the URL already on record stays valid.
 */
export function buildAttachmentS3Key(
  agodaId: string | null | undefined,
  messageId: string,
  filename: string
): string {
  return `support-email-attachments/${agodaId || "unknown"}/${messageId}/${sanitizeFilename(filename)}`;
}

/**
 * Uploads one attachment. Never throws: losing the archive copy must not fail
 * the scrape, so the reason is returned for the caller to record instead.
 */
export async function uploadAttachmentToS3(
  input: AttachmentUploadInput
): Promise<AttachmentUploadResult> {
  const s3Key = buildAttachmentS3Key(
    input.agodaId,
    input.messageId,
    input.filename
  );

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: input.buffer,
        ContentType: contentTypeFor(input.mimeType, input.format),
        Metadata: {
          messageId: input.messageId,
          agodaId: input.agodaId || "unknown",
          uploadedAt: new Date().toISOString(),
        },
      })
    );

    const s3Url = `https://${bucketName}.s3.${
      process.env.AWS_REGION || "us-east-1"
    }.amazonaws.com/${s3Key}`;

    await dualLogInfo(`☁️ Uploaded attachment ${input.filename} to S3`, {
      messageId: input.messageId,
      agodaId: input.agodaId,
      s3Key,
    });

    return { s3Url, s3Key };
  } catch (error: any) {
    const uploadError = error?.message || String(error);
    await dualLogWarn(
      `⚠️ Failed to upload attachment ${input.filename} to S3`,
      { messageId: input.messageId, s3Key, error: uploadError }
    );
    return { s3Url: null, s3Key, uploadError };
  }
}
