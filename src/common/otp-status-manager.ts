import dotenv from "dotenv";
import { EventEmitter } from "events";
import mongoose, { Types } from "mongoose";
import {
  IOtpStatus,
  OtpPlatform,
  OtpStatus,
  OtpStatusValue,
} from "../models/otp-status.model.js";
import { phoneNumberSlotService } from "../services/phone-number-slot.service.js";

dotenv.config();

export interface OtpStatusInfo {
  status: OtpStatusValue;
  platform: OtpPlatform | null;
  jobId: string | null;
  lastUpdated: Date;
}

let instance: OtpStatusManager | null = null;

/** Default platform for `otp_status` rows (Expedia/Agoda). Booking uses `phone_number_slots`, not this collection. */
const FALLBACK_OTP_DB_PLATFORM = OtpPlatform.Expedia;

/** Map env / legacy DB values to schema enum (`expedia` | `agoda` | `booking`). */
function normalizeOtpPlatformInput(
  raw: string | undefined
): OtpPlatform | null {
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  const r = String(raw).trim().toLowerCase();
  if (r === "expedia" || r === "expedia_retrieval") {
    return OtpPlatform.Expedia;
  }
  if (r === "agoda") {
    return OtpPlatform.Agoda;
  }
  if (r === "booking") {
    return OtpPlatform.Booking;
  }
  return null;
}

export class OtpStatusManager extends EventEmitter {
  private currentStatus: OtpStatusInfo | null = null;
  private isInitialized = false;

  private constructor() {
    super();
  }

  public static getInstance(): OtpStatusManager {
    if (!instance) {
      instance = new OtpStatusManager();
    }
    return instance;
  }

  private getOtpDbPlatform(): OtpPlatform {
    const fromEnv = normalizeOtpPlatformInput(process.env.OTP_PLATFORM);
    if (fromEnv != null) {
      return fromEnv;
    }
    if (
      process.env.OTP_PLATFORM != null &&
      String(process.env.OTP_PLATFORM).trim() !== ""
    ) {
      console.warn(
        `[OtpStatusManager] OTP_PLATFORM=${JSON.stringify(process.env.OTP_PLATFORM)} is not expedia, expedia_retrieval, agoda, or booking; using otp_status default platform ${FALLBACK_OTP_DB_PLATFORM}`
      );
    }
    return FALLBACK_OTP_DB_PLATFORM;
  }

  /** Legacy installs used non-enum platform strings; Mongoose rejects them on create/save. */
  private async migrateLegacyOtpPlatforms(): Promise<void> {
    await OtpStatus.collection.updateMany(
      { platform: "expedia_retrieval" },
      { $set: { platform: OtpPlatform.Expedia } }
    );
  }

  /** One `otp_status` row per `platform` value. */
  private async dedupeOtpStatusByPlatform(): Promise<void> {
    for (const p of Object.values(OtpPlatform)) {
      const docs = await OtpStatus.find({ platform: p })
        .sort({ updatedAt: -1 })
        .exec();
      if (docs.length <= 1) {
        continue;
      }
      const occupied = docs.find((d) => d.status === OtpStatusValue.Occupied);
      const keeper = occupied ?? docs[0];
      await OtpStatus.deleteMany({
        platform: p,
        _id: { $ne: keeper._id },
      });
    }
  }

  private async ensurePlatformDoc(): Promise<void> {
    const envPlatform = this.getOtpDbPlatform();
    if (envPlatform === OtpPlatform.Booking) {
      return;
    }
    const existing = await OtpStatus.findOne({ platform: envPlatform });
    if (!existing) {
      await OtpStatus.create({
        status: OtpStatusValue.Released,
        platform: envPlatform,
        job_id: null,
      });
    }
  }

  private async syncCurrentStatusFromDb(): Promise<void> {
    const occupied = await OtpStatus.findOne({
      status: OtpStatusValue.Occupied,
    })
      .sort({ updatedAt: -1 })
      .lean();

    if (occupied) {
      this.currentStatus = {
        status: OtpStatusValue.Occupied,
        platform: occupied.platform || FALLBACK_OTP_DB_PLATFORM,
        jobId: occupied.job_id?.toString() || null,
        lastUpdated: occupied.updatedAt,
      };
    } else {
      this.currentStatus = {
        status: OtpStatusValue.Released,
        platform: this.getOtpDbPlatform(),
        jobId: null,
        lastUpdated: new Date(),
      };
    }
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await this.migrateLegacyOtpPlatforms();
      await this.dedupeOtpStatusByPlatform();
      await this.ensurePlatformDoc();
      await this.syncCurrentStatusFromDb();
      this.isInitialized = true;
      console.log("OTP Status Manager initialized:", this.currentStatus);
    } catch (error) {
      console.error("Failed to initialize OTP Status Manager:", error);
      throw error;
    }
  }

  public getCurrentStatus(): OtpStatusInfo | null {
    return this.currentStatus;
  }

  /**
   * True if the OTP row for `OTP_PLATFORM` is free (or missing).
   */
  public async isOtpAvailable(): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const envPlatform = this.getOtpDbPlatform();
    const doc = await OtpStatus.findOne({ platform: envPlatform }).lean();

    if (!doc) {
      return true;
    }
    return doc.status === OtpStatusValue.Released;
  }

  private async ensurePlatformRow(): Promise<void> {
    const envPlatform = this.getOtpDbPlatform();
    await OtpStatus.updateOne(
      { platform: envPlatform },
      {
        $setOnInsert: {
          status: OtpStatusValue.Released,
          platform: envPlatform,
          job_id: null,
        },
      },
      { upsert: true }
    );
  }

  /**
   * Reserve OTP for a job in `otp_status` for the current `OTP_PLATFORM` (Expedia/Agoda).
   * Booking uses `phone_number_slots`, not this.
   */
  public async reserveOtp(jobId: string): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!Types.ObjectId.isValid(jobId)) {
      console.error(`reserveOtp: invalid jobId ${jobId}`);
      return false;
    }

    const envPlatform = this.getOtpDbPlatform();

    try {
      await this.ensurePlatformRow();

      const result = await OtpStatus.findOneAndUpdate(
        {
          status: OtpStatusValue.Released,
          platform: envPlatform,
        },
        {
          status: OtpStatusValue.Occupied,
          platform: envPlatform,
          job_id: new mongoose.Types.ObjectId(jobId),
        },
        { new: true }
      );

      if (result) {
        await this.syncCurrentStatusFromDb();
        console.log(`OTP reserved for job ${jobId} (${envPlatform})`);
        this.emit("otpReserved", jobId, envPlatform);
        return true;
      }

      console.log(
        `Failed to reserve OTP for job ${jobId} — slot busy (${envPlatform})`
      );
      return false;
    } catch (error) {
      console.error(`Error reserving OTP for job ${jobId}:`, error);
      return false;
    }
  }

  /**
   * Release the row held by this job (matches job_id).
   */
  public async releaseOtp(jobId: string): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      if (!Types.ObjectId.isValid(jobId)) {
        return false;
      }

      const result = await OtpStatus.findOneAndUpdate(
        { job_id: new mongoose.Types.ObjectId(jobId) },
        {
          status: OtpStatusValue.Released,
          job_id: null,
        },
        { new: true }
      );

      if (result) {
        await this.syncCurrentStatusFromDb();
        console.log(`\x1b[32mOTP released by job ${jobId}\x1b[0m`);
        this.emit("otpReleased", jobId);
        return true;
      }

      return true;
    } catch (error) {
      console.error(`Error releasing OTP for job ${jobId}:`, error);
      return false;
    }
  }

  /**
   * Admin / shutdown: release all `phone_number_slots` (Booking) and all `otp_status` rows (Expedia/Agoda).
   */
  public async forceReleaseOtp(): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      await phoneNumberSlotService.releaseAllOccupied();

      await OtpStatus.updateMany(
        {},
        {
          status: OtpStatusValue.Released,
          job_id: null,
        }
      );

      await this.syncCurrentStatusFromDb();
      console.log(
        `\x1b[32m[OTP] All OTP rows force-released — emitting 'otpReleased'\x1b[0m`
      );
      this.emit("otpReleased", null);
      return true;
    } catch (error) {
      console.error("Error force releasing OTP:", error);
      return false;
    }
  }

  public async waitForOtpAvailable(
    timeoutMs: number = 60000
  ): Promise<boolean> {
    const ok = await this.isOtpAvailable();
    if (ok) {
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

  public async getDetailedStatus(): Promise<IOtpStatus[]> {
    try {
      return (await OtpStatus.find({}).lean()) as IOtpStatus[];
    } catch (error) {
      console.error("Error getting detailed OTP status:", error);
      return [];
    }
  }

  public async refreshFromDatabase(): Promise<void> {
    try {
      const oldStatus = this.currentStatus?.status;
      await this.syncCurrentStatusFromDb();
      if (!this.currentStatus) {
        return;
      }
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
    } catch (error) {
      console.error("Error refreshing OTP status from database:", error);
    }
  }
}

export const otpStatusManager = OtpStatusManager.getInstance();
