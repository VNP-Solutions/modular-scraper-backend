import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { existsSync, mkdirSync } from "fs";
import fs from "fs/promises";
import * as path from "path";
import dotenv from "dotenv"
import { emailNotifier } from "./email-notifier.js";
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

    // switch (level) {
    //   case "error":
    //     console.error(consoleMessage);
    //     break;
    //   case "warn":
    //     console.warn(consoleMessage);
    //     break;
    //   case "debug":
    //     console.debug(consoleMessage);
    //     break;
    //   default:
    //     console.log(consoleMessage);
    // }

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

  private async uploadToS3(filePath?: string, fileType: 'log' | 'screenshot' = 'log'): Promise<string | null> {
    try {
      const targetPath = filePath || this.logFilePath;
      const fileContent = await fs.readFile(targetPath);
      const fileName = path.basename(targetPath);

      let s3FileName: string;
      if (fileType === 'screenshot') {
        const timestamp = Date.now();
        const nameWithoutExt = fileName.replace('.png', '');
        s3FileName = `${nameWithoutExt}_${timestamp}.png`;
      } else {
        s3FileName = fileName;
      }

      const s3Key = `job-logs/${this.jobId}/${s3FileName}`;
  
      const command = new PutObjectCommand({
        Bucket: this.s3BucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: fileType === 'log' ? "text/plain" : "image/png",
        Metadata: {
          jobId: this.jobId,
          uploadedAt: new Date().toISOString(),
          type: fileType,
        },
      });
  
      await this.s3Client.send(command);
  
      const s3Url = `https://${this.s3BucketName}.s3.${
        process.env.AWS_REGION || "us-east-1"
      }.amazonaws.com/${s3Key}`;
  
      console.log(`${fileType} uploaded to S3: ${s3Url}`);
      return s3Url;
    } catch (error) {
      console.error(`Failed to upload ${fileType} to S3:`, error);
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
    jobStatus: "success" | "failed" | "partial",
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
      const screenshotUrl = await this.uploadScreenshotToS3();

      if (jobStatus === "failed") {
        await this.sendFailureEmail(s3Url, screenshotUrl);
      }

      // Delete local file
      await this.deleteLocalFile();
      await this.deleteScreenshot();

      // Remove instance from memory
      JobLogger.removeInstance(this.jobId);
      console.log(`Job ${this.jobId} finalized. Log: ${s3Url}, Screenshot: ${screenshotUrl || 'none'}`);
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

  private async uploadScreenshotToS3(): Promise<string | null> {
    try {
      const screenshotPath = this.getScreenshotPath();
      
      // Check if screenshot exists
      if (!(await this.fileExists(screenshotPath))) {
        console.log(`No screenshot found at: ${screenshotPath}`);
        return null;
      }
      
      const s3Url = await this.uploadToS3(screenshotPath, 'screenshot');
      if (s3Url) {
        console.log(`Screenshot uploaded: ${this.getScreenshotFilename()} -> ${s3Url}`);
      }
      return s3Url;
    } catch (error) {
      console.error("Failed to upload screenshot:", error);
      return null;
    }
  }

  private async deleteScreenshot(): Promise<void> {
    try {
      const screenshotPath = this.getScreenshotPath();
      
      // Check if screenshot exists
      if (!(await this.fileExists(screenshotPath))) {
        console.log(`No screenshot to delete at: ${screenshotPath}`);
        return;
      }
      
      await fs.unlink(screenshotPath);
      console.log(`Local screenshot deleted: ${screenshotPath}`);
    } catch (error) {
      console.error("Failed to delete screenshot:", error);
    }
  }

  private getScreenshotFilename(): string {
    const jobId = this.jobId || 'trust';
    return `scraping_last_step_${jobId}.png`;
  }
  
  private getScreenshotPath(): string {
    return path.join(process.cwd(), this.getScreenshotFilename());
  }
  
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  public async sendFailureEmail(logS3Url?: string | null, screenshotS3Url?: string | null): Promise<void> {
    try {
      const errorMessage = `Job ${this.jobId} failed during execution`;
      
      const errorDetails = {
        jobId: this.jobId,
        totalLogEntries: this.logEntries.length,
        logFileUrl: logS3Url || 'Not uploaded',
        screenshotUrl: screenshotS3Url || 'Not uploaded',
      };
  
      await emailNotifier.notifyJobError(
        this.jobId,
        errorMessage,
        errorDetails
      );
  
      console.log(`Failure notification email sent for job ${this.jobId}`);
    } catch (error) {
      console.error(`Failed to send failure email for job ${this.jobId}:`, error);
    }
  }
}

// Utility functions to maintain existing console.log functionality while adding logging
export function createJobLogger(jobId: string): JobLogger {
  return JobLogger.getInstance(jobId);
}

export function getJobLogger(jobId: string): JobLogger | null {
  return JobLogger.getInstance(jobId);
}
