import dotenv from "dotenv";
import { EventEmitter } from "events";
import mongoose from "mongoose";
import {
  IOtpStatus,
  OtpPlatform,
  OtpStatus,
  OtpStatusValue,
} from "../models/otp-status.model.js";

dotenv.config();

export interface OtpStatusInfo {
  status: OtpStatusValue;
  platform: OtpPlatform | null;
  jobId: string | null;
  lastUpdated: Date;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 11000
  );
}

export class OtpStatusManager extends EventEmitter {
  private static instance: OtpStatusManager | null = null;
  private currentStatus: OtpStatusInfo | null = null;
  private isInitialized = false;

  private constructor() {
    super();
  }

  private getOtpPlatform(): OtpPlatform {
    if (process.env.OTP_PLATFORM === OtpPlatform.ExpediaRetrieval) {
      return OtpPlatform.ExpediaRetrieval;
    }
    return OtpPlatform.Expedia;
  }

  public static getInstance(): OtpStatusManager {
    if (!OtpStatusManager.instance) {
      OtpStatusManager.instance = new OtpStatusManager();
    }
    return OtpStatusManager.instance;
  }

  /**
   * Remove duplicate OTP docs per platform so a unique index can be applied.
   * Keeps the most recently updated document for each platform.
   */
  private async dedupePlatformDocs(): Promise<void> {
    const platforms = Object.values(OtpPlatform);

    for (const platform of platforms) {
      const docs = await OtpStatus.find({ platform })
        .sort({ updatedAt: -1 })
        .select("_id")
        .lean();

      if (docs.length <= 1) {
        continue;
      }

      const idsToDelete = docs.slice(1).map((doc) => doc._id);
      const deleteResult = await OtpStatus.deleteMany({
        _id: { $in: idsToDelete },
      });

      console.log(
        `Removed ${deleteResult.deletedCount} duplicate OTP status doc(s) for platform ${platform}`
      );
    }
  }

  /**
   * Ensure exactly one OTP status document exists for a platform.
   */
  private async ensurePlatformDoc(platform: OtpPlatform): Promise<void> {
    try {
      await OtpStatus.updateOne(
        { platform },
        {
          $setOnInsert: {
            status: OtpStatusValue.Released,
            platform,
            job_id: null,
          },
        },
        { upsert: true }
      );
    } catch (error) {
      // Another process created the doc first — unique index makes this expected
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }

  /**
   * Initialize the OTP status manager by loading current status from database
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await this.dedupePlatformDocs();

      const platform = this.getOtpPlatform();
      await this.ensurePlatformDoc(platform);

      const otpStatusDoc = await OtpStatus.findOne({ platform }).lean();

      if (!otpStatusDoc) {
        throw new Error(
          `Failed to initialize OTP status document for platform ${platform}`
        );
      }

      this.currentStatus = {
        status: otpStatusDoc.status,
        platform: otpStatusDoc.platform || platform,
        jobId: otpStatusDoc.job_id?.toString() || null,
        lastUpdated: otpStatusDoc.updatedAt,
      };

      this.isInitialized = true;
      console.log("OTP Status Manager initialized:", this.currentStatus);
    } catch (error) {
      console.error("Failed to initialize OTP Status Manager:", error);
      throw error;
    }
  }

  /**
   * Get current OTP status (from memory for performance)
   */
  public getCurrentStatus(): OtpStatusInfo | null {
    return this.currentStatus;
  }

  /**
   * Check if OTP is currently available (Released status)
   */
  public isOtpAvailable(): boolean {
    return this.currentStatus?.status === OtpStatusValue.Released;
  }

  /**
   * Reserve OTP for a specific job with platform
   */
  public async reserveOtp(
    jobId: string,
    platform: OtpPlatform
  ): Promise<boolean> {
    // Use the platform parameter passed in, don't override it
    // This allows different job types to use different platforms
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Atomically ensure one doc exists (unique index prevents duplicates)
      await this.ensurePlatformDoc(platform);

      // Atomically claim only if currently Released — one winner under concurrency
      const result = await OtpStatus.findOneAndUpdate(
        { status: OtpStatusValue.Released, platform: platform },
        {
          status: OtpStatusValue.Occupied,
          platform: platform,
          job_id: new mongoose.Types.ObjectId(jobId),
        },
        { new: true }
      );

      if (result) {
        // Successfully reserved
        this.currentStatus = {
          status: OtpStatusValue.Occupied,
          platform: platform,
          jobId: jobId,
          lastUpdated: result.updatedAt,
        };

        console.log(`OTP reserved for job ${jobId} on platform ${platform}`);
        this.emit("otpReserved", jobId, platform);
        return true;
      } else {
        // OTP is already occupied — sync in-memory status from DB
        const occupied = await OtpStatus.findOne({ platform }).lean();
        if (occupied) {
          this.currentStatus = {
            status: occupied.status,
            platform: occupied.platform || platform,
            jobId: occupied.job_id?.toString() || null,
            lastUpdated: occupied.updatedAt,
          };
        }

        console.log(
          `Failed to reserve OTP for job ${jobId} on platform ${platform} - already occupied`
        );
        return false;
      }
    } catch (error) {
      console.error(`Error reserving OTP for job ${jobId}:`, error);
      return false;
    }
  }

  /**
   * Release OTP after job completes its OTP work
   */
  public async releaseOtp(jobId: string): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Only release if the current job is the one that reserved it
      const result = await OtpStatus.findOneAndUpdate(
        {
          status: OtpStatusValue.Occupied,
          job_id: new mongoose.Types.ObjectId(jobId),
        },
        {
          status: OtpStatusValue.Released,
          job_id: null,
        },
        { new: true }
      );

      if (result) {
        // Successfully released
        this.currentStatus = {
          status: OtpStatusValue.Released,
          platform: result.platform || null,
          jobId: null,
          lastUpdated: result.updatedAt,
        };

        console.log(`\x1b[32mOTP released by job ${jobId}\x1b[0m`);
        this.emit("otpReleased", jobId);
        return true;
      } else {
        console.log(
          `\x1b[33mFailed to release OTP for job ${jobId} - not currently owner\x1b[0m`
        );
        return false;
      }
    } catch (error) {
      console.error(`Error releasing OTP for job ${jobId}:`, error);
      return false;
    }
  }

  /**
   * Force release OTP (for error handling or system cleanup)
   */
  public async forceReleaseOtp(): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const platform = this.getOtpPlatform();
      await this.ensurePlatformDoc(platform);

      const result = await OtpStatus.findOneAndUpdate(
        { platform },
        {
          status: OtpStatusValue.Released,
          job_id: null,
        },
        { new: true }
      );

      if (result) {
        this.currentStatus = {
          status: OtpStatusValue.Released,
          platform,
          jobId: null,
          lastUpdated: result.updatedAt,
        };

        console.log("OTP force released");
        this.emit("otpReleased", null);
        return true;
      }
      return false;
    } catch (error) {
      console.error("Error force releasing OTP:", error);
      return false;
    }
  }

  /**
   * Wait for OTP to become available
   */
  public async waitForOtpAvailable(
    timeoutMs: number = 60000
  ): Promise<boolean> {
    if (this.isOtpAvailable()) {
      return true;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.removeListener("otpReleased", onOtpReleased);
        resolve(false);
      }, timeoutMs);

      const onOtpReleased = () => {
        clearTimeout(timeout);
        this.removeListener("otpReleased", onOtpReleased);
        resolve(true);
      };

      this.once("otpReleased", onOtpReleased);
    });
  }

  /**
   * Get detailed status for debugging
   */
  public async getDetailedStatus(): Promise<IOtpStatus | null> {
    try {
      return await OtpStatus.findOne({
        platform: this.getOtpPlatform(),
      }).lean();
    } catch (error) {
      console.error("Error getting detailed OTP status:", error);
      return null;
    }
  }

  /**
   * Refresh status from database (in case of external changes)
   */
  public async refreshFromDatabase(): Promise<void> {
    try {
      const otpStatusDoc = await OtpStatus.findOne({
        platform: this.getOtpPlatform(),
      }).lean();
      if (otpStatusDoc) {
        const oldStatus = this.currentStatus?.status;
        this.currentStatus = {
          status: otpStatusDoc.status,
          platform: otpStatusDoc.platform || this.getOtpPlatform(),
          jobId: otpStatusDoc.job_id?.toString() || null,
          lastUpdated: otpStatusDoc.updatedAt,
        };

        // Emit event if status changed
        if (oldStatus !== this.currentStatus.status) {
          if (this.currentStatus.status === OtpStatusValue.Released) {
            this.emit("otpReleased", this.currentStatus.jobId);
          } else {
            this.emit(
              "otpReserved",
              this.currentStatus.jobId,
              this.currentStatus.platform
            );
          }
        }
      }
    } catch (error) {
      console.error("Error refreshing OTP status from database:", error);
    }
  }
}

// Export singleton instance
export const otpStatusManager = OtpStatusManager.getInstance();
