import { EventEmitter } from "events";
import mongoose from "mongoose";
import {
  IOtpStatus,
  OtpPlatform,
  OtpStatus,
  OtpStatusValue,
} from "../models/otp-status.model.js";
import dotenv from "dotenv";

dotenv.config();

export interface OtpStatusInfo {
  status: OtpStatusValue;
  platform: OtpPlatform | null;
  jobId: string | null;
  lastUpdated: Date;
}

export class OtpStatusManager extends EventEmitter {
  private static instance: OtpStatusManager | null = null;
  private currentStatus: OtpStatusInfo | null = null;
  private isInitialized = false;

  private constructor() {
    super();
  }

  private getOtpPlatform(): OtpPlatform {
    if (process.env.OTP_PLATFORM === OtpPlatform.Agoda) {
      return OtpPlatform.Agoda;
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
   * Initialize the OTP status manager by loading current status from database
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Get or create the OTP status document
      const otpStatusDoc = await OtpStatus.findOne({
        platform: this.getOtpPlatform(),
      }).lean();

      if (!otpStatusDoc) {
        // Create initial OTP status as Released
        const newDoc = await OtpStatus.create({
          status: OtpStatusValue.Released,
          platform: this.getOtpPlatform(),
          job_id: null,
        });

        this.currentStatus = {
          status: newDoc.status,
          platform: this.getOtpPlatform(),
          jobId: null,
          lastUpdated: newDoc.updatedAt,
        };
      } else {
        this.currentStatus = {
          status: otpStatusDoc.status,
          platform: otpStatusDoc.platform || this.getOtpPlatform(),
          jobId: otpStatusDoc.job_id?.toString() || null,
          lastUpdated: otpStatusDoc.updatedAt,
        };
      }

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
    platform = this.getOtpPlatform();
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Attempt to reserve OTP atomically
      const result = await OtpStatus.findOneAndUpdate(
        { status: OtpStatusValue.Released, platform: platform }, // Only update if currently Released
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
        // OTP is already occupied
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
          platform: null,
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
      const result = await OtpStatus.findOneAndUpdate(
        {
          platform: this.getOtpPlatform(),
        }, // Match any document
        {
          status: OtpStatusValue.Released,
          job_id: null,
        },
        { new: true, upsert: true }
      );

      if (result) {
        this.currentStatus = {
          status: OtpStatusValue.Released,
          platform: this.getOtpPlatform(),
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
      return await OtpStatus.findOne().lean();
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
