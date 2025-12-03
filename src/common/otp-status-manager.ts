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
    // Use the platform parameter passed in, don't override it
    // This allows different job types to use different platforms
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Extract valid ObjectId from jobId if it's not already a valid ObjectId
      // For retrieval jobs, jobId format is: retrieval_job_${retrieval_id}_${Date.now()}
      let objectIdForReservation: mongoose.Types.ObjectId | null = null;

      if (mongoose.Types.ObjectId.isValid(jobId)) {
        // jobId is already a valid ObjectId
        objectIdForReservation = new mongoose.Types.ObjectId(jobId);
      } else if (jobId.startsWith("retrieval_job_")) {
        // Extract retrieval_id from jobId format: retrieval_job_${retrieval_id}_${Date.now()}
        const parts = jobId.split("_");
        if (parts.length >= 3 && mongoose.Types.ObjectId.isValid(parts[2])) {
          objectIdForReservation = new mongoose.Types.ObjectId(parts[2]);
        }
      }

      // Attempt to reserve OTP atomically
      const updateData: any = {
        status: OtpStatusValue.Occupied,
        platform: platform,
      };

      if (objectIdForReservation) {
        updateData.job_id = objectIdForReservation;
      }

      // First check if an entry exists for this platform (regardless of status)
      const existingEntry = await OtpStatus.findOne({
        platform: platform,
      }).lean();

      if (!existingEntry) {
        // No entry exists for this platform, create one as Released first
        await OtpStatus.create({
          status: OtpStatusValue.Released,
          platform: platform,
          job_id: null,
        });
        console.log(
          `Created new OTP status entry for platform ${platform} as Released`
        );
      }

      // Now try to reserve (update from Released to Occupied)
      const result = await OtpStatus.findOneAndUpdate(
        { status: OtpStatusValue.Released, platform: platform }, // Only update if currently Released
        updateData,
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
        // Check what the actual status is
        const currentEntry = await OtpStatus.findOne({
          platform: platform,
        }).lean();

        if (currentEntry) {
          if (currentEntry.status === OtpStatusValue.Occupied) {
            console.log(
              `Failed to reserve OTP for job ${jobId} on platform ${platform} - already occupied by job ${currentEntry.job_id}`
            );
          } else {
            console.log(
              `Failed to reserve OTP for job ${jobId} on platform ${platform} - unexpected status: ${currentEntry.status}`
            );
          }
        } else {
          console.log(
            `Failed to reserve OTP for job ${jobId} on platform ${platform} - no entry found after creation attempt`
          );
        }
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
      // Extract valid ObjectId from jobId if it's not already a valid ObjectId
      // For retrieval jobs, jobId format is: retrieval_job_${retrieval_id}_${Date.now()}
      let objectIdForRelease: mongoose.Types.ObjectId | null = null;

      if (mongoose.Types.ObjectId.isValid(jobId)) {
        // jobId is already a valid ObjectId
        objectIdForRelease = new mongoose.Types.ObjectId(jobId);
      } else if (jobId.startsWith("retrieval_job_")) {
        // Extract retrieval_id from jobId format: retrieval_job_${retrieval_id}_${Date.now()}
        const parts = jobId.split("_");
        if (parts.length >= 3 && mongoose.Types.ObjectId.isValid(parts[2])) {
          objectIdForRelease = new mongoose.Types.ObjectId(parts[2]);
        }
      }

      // Build query to find the OTP status
      const query: any = {
        status: OtpStatusValue.Occupied,
      };

      if (objectIdForRelease) {
        query.job_id = objectIdForRelease;
      } else {
        // If we can't extract a valid ObjectId, we can't match by job_id
        // In this case, we'll try to release based on current status only
        // This is a fallback for edge cases
        console.warn(
          `Cannot extract valid ObjectId from jobId ${jobId} for OTP release. Attempting release by status only.`
        );
      }

      // Only release if the current job is the one that reserved it
      const result = await OtpStatus.findOneAndUpdate(
        query,
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
        // OTP is not currently owned by this job (might have been released already or never reserved)
        // This is normal for stopped jobs or jobs that failed before reserving OTP
        // Only log as info, not as an error
        if (objectIdForRelease) {
          console.log(
            `OTP not owned by job ${jobId} (may have been released already or never reserved)`
          );
        } else {
          console.log(
            `Cannot release OTP for job ${jobId} - invalid jobId format for OTP tracking`
          );
        }
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
