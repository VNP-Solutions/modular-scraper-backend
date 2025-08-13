import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { promisify } from "util";
import { dualLogError, dualLogInfo, dualLogWarn } from "./log-helper.js";

dotenv.config();

const streamPipeline = promisify(pipeline);

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const S3_BUCKET_NAME = process.env.AWS_S3_BUCKET as string;
const S3_TOKEN_KEY = process.env.S3_TOKEN_KEY || "keyspace/token.json";

const s3Client = new S3Client({ region: AWS_REGION });

export async function downloadTokenFromS3ToLocal(
  localTokenPath: string
): Promise<boolean> {
  if (!S3_BUCKET_NAME) {
    await dualLogWarn(
      "S3 bucket not configured; skipping token download from S3",
      {}
    );
    return false;
  }

  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: S3_TOKEN_KEY })
    );

    if (!response.Body) {
      await dualLogWarn("S3 token object has no body", {
        bucket: S3_BUCKET_NAME,
        key: S3_TOKEN_KEY,
      });
      return false;
    }

    const dir = path.dirname(localTokenPath);
    fs.mkdirSync(dir, { recursive: true });

    await streamPipeline(
      response.Body as NodeJS.ReadableStream,
      fs.createWriteStream(localTokenPath)
    );

    await dualLogInfo("Downloaded token from S3 to local", {
      bucket: S3_BUCKET_NAME,
      key: S3_TOKEN_KEY,
      localTokenPath,
    });
    return true;
  } catch (error: any) {
    const notFound =
      error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey";
    if (notFound) {
      await dualLogWarn("Token not found in S3", {
        bucket: S3_BUCKET_NAME,
        key: S3_TOKEN_KEY,
      });
      return false;
    }
    await dualLogError("Failed to download token from S3", error, {
      bucket: S3_BUCKET_NAME,
      key: S3_TOKEN_KEY,
    });
    return false;
  }
}

export async function uploadTokenToS3FromData(
  tokenData: unknown
): Promise<boolean> {
  if (!S3_BUCKET_NAME) {
    await dualLogWarn(
      "S3 bucket not configured; skipping token upload to S3",
      {}
    );
    return false;
  }
  try {
    const body = Buffer.from(JSON.stringify(tokenData, null, 2), "utf8");
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: S3_TOKEN_KEY,
        Body: body,
        ContentType: "application/json",
      })
    );
    await dualLogInfo("Uploaded token to S3", {
      bucket: S3_BUCKET_NAME,
      key: S3_TOKEN_KEY,
    });
    return true;
  } catch (error) {
    await dualLogError("Failed to upload token to S3", error, {
      bucket: S3_BUCKET_NAME,
      key: S3_TOKEN_KEY,
    });
    return false;
  }
}

export const TOKEN_S3_DETAILS = { bucket: S3_BUCKET_NAME, key: S3_TOKEN_KEY };

export async function readTokenDataFromS3<T = any>(): Promise<T | null> {
  if (!S3_BUCKET_NAME) {
    await dualLogWarn(
      "S3 bucket not configured; cannot read token from S3",
      {}
    );
    return null;
  }
  try {
    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: S3_TOKEN_KEY })
    );
    if (!res.Body) return null;

    // Node.js SDK v3 provides transformToString/transformToByteArray on Body
    const text = await (res.Body as any).transformToString();
    return JSON.parse(text) as T;
  } catch (error) {
    await dualLogError("Failed to read token directly from S3", error, {
      bucket: S3_BUCKET_NAME,
      key: S3_TOKEN_KEY,
    });
    return null;
  }
}
