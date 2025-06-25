import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { existsSync, mkdirSync } from "fs";
import fs from "fs/promises";
import * as path from "path";
import dotenv from "dotenv"
dotenv.config()

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  metadata?: any;
}

export class JobLogger {
  private static instances: Map<string, JobLogger> = new Map();
  private logEntries: LogEntry[] = [];
  private logFilePath: string;
  private jobId: string;
  private s3Client: S3Client;
  private s3BucketName: string;

  private constructor(jobId: string) {
    this.jobId = jobId;
    this.logFilePath = path.join(
      process.cwd(),
      `logs/job_${jobId}_${Date.now()}.log`
    );

    // Initialize S3 client
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });

    this.s3BucketName = process.env.S3_BUCKET_NAME || "vnpstorage";

    this.initializeLogFile();
  }

  public static getInstance(jobId: string): JobLogger {
    if (!this.instances.has(jobId)) {
      this.instances.set(jobId, new JobLogger(jobId));
    }
    return this.instances.get(jobId)!;
  }

  public static removeInstance(jobId: string): void {
    this.instances.delete(jobId);
  }

  private async initializeLogFile(): Promise<void> {
    try {
      // Ensure logs directory exists
      const logsDir = path.dirname(this.logFilePath);
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }

      // Create log file with initial entry
      const initialEntry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Job ${this.jobId} logging started`,
        metadata: { jobId: this.jobId },
      };

      await this.writeToFile(initialEntry);

      console.log(`📝 Log file created: ${this.logFilePath}`);
    } catch (error) {
      console.error("Failed to initialize log file:", error);
    }
  }

  private async writeToFile(entry: LogEntry): Promise<void> {
    try {
      const logLine = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${
        entry.message
      }${
        entry.metadata ? ` | Metadata: ${JSON.stringify(entry.metadata)}` : ""
      }\n`;

      await fs.appendFile(this.logFilePath, logLine);
      this.logEntries.push(entry);
    } catch (error) {
      console.error("Failed to write to log file:", error);
    }
  }

  public async log(
    level: "info" | "warn" | "error" | "debug",
    message: string,
    metadata?: any
  ): Promise<void> {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata,
    };

    // Write to console (keeping original functionality)
    const consoleMessage = metadata
      ? `${message} | ${JSON.stringify(metadata)}`
      : message;

    switch (level) {
      case "error":
        console.error(consoleMessage);
        break;
      case "warn":
        console.warn(consoleMessage);
        break;
      case "debug":
        console.debug(consoleMessage);
        break;
      default:
        console.log(consoleMessage);
    }

    // Write to log file
    await this.writeToFile(entry);
  }

  public async info(message: string, metadata?: any): Promise<void> {
    await this.log("info", message, metadata);
  }

  public async warn(message: string, metadata?: any): Promise<void> {
    await this.log("warn", message, metadata);
  }

  public async error(message: string, metadata?: any): Promise<void> {
    await this.log("error", message, metadata);
  }

  public async debug(message: string, metadata?: any): Promise<void> {
    await this.log("debug", message, metadata);
  }

  private async uploadToS3(): Promise<string | null> {
    try {
      const fileContent = await fs.readFile(this.logFilePath);
      const fileName = path.basename(this.logFilePath);
      const s3Key = `job-logs/${this.jobId}/${fileName}`;

      const command = new PutObjectCommand({
        Bucket: this.s3BucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: "text/plain",
        Metadata: {
          jobId: this.jobId,
          uploadedAt: new Date().toISOString(),
        },
      });

      await this.s3Client.send(command);

      const s3Url = `https://${this.s3BucketName}.s3.${
        process.env.AWS_REGION || "us-east-1"
      }.amazonaws.com/${s3Key}`;

      console.log(`📤 Log file uploaded to S3: ${s3Url}`);
      return s3Url;
    } catch (error) {
      console.error("Failed to upload log file to S3:", error);
      return null;
    }
  }

  private async deleteLocalFile(): Promise<void> {
    try {
      await fs.unlink(this.logFilePath);
      console.log(`🗑️ Local log file deleted: ${this.logFilePath}`);
    } catch (error) {
      console.error("Failed to delete local log file:", error);
    }
  }

  public async finalize(
    jobStatus: "success" | "failed" | "partial"
  ): Promise<string | null> {
    try {
      // Log job completion
      await this.log(
        "info",
        `Job ${this.jobId} completed with status: ${jobStatus}`,
        {
          jobId: this.jobId,
          status: jobStatus,
          totalLogEntries: this.logEntries.length,
          completedAt: new Date().toISOString(),
        }
      );

      // Upload to S3
      const s3Url = await this.uploadToS3();

      // Delete local file
      await this.deleteLocalFile();

      // Remove instance from memory
      JobLogger.removeInstance(this.jobId);

      return s3Url;
    } catch (error) {
      console.error("Failed to finalize logger:", error);
      return null;
    }
  }

  public getLogFilePath(): string {
    return this.logFilePath;
  }

  public getLogEntriesCount(): number {
    return this.logEntries.length;
  }
}

// Utility functions to maintain existing console.log functionality while adding logging
export function createJobLogger(jobId: string): JobLogger {
  return JobLogger.getInstance(jobId);
}

export function getJobLogger(jobId: string): JobLogger | null {
  return JobLogger.getInstance(jobId);
}
