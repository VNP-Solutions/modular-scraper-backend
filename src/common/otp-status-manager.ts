import dotenv from "dotenv";
import { EventEmitter } from "events";
import mongoose, { Types } from "mongoose";
import {
  IOtpStatus,
  OtpPlatform,
  OtpStatus,
  OtpStatusValue,
} from "../models/otp-status.model.js";
import { DEFAULT_BOOKING_OTP_LANE } from "./booking-otp-lane.js";
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

  private normalizeLaneKey(laneKey: string): string {
    const s = (laneKey || DEFAULT_BOOKING_OTP_LANE).trim() || DEFAULT_BOOKING_OTP_LANE;
    return s.slice(0, 256);
  }

  /** Legacy installs used non-enum platform strings; Mongoose rejects them on create/save. */
  private async migrateLegacyOtpPlatforms(): Promise<void> {
    await OtpStatus.collection.updateMany(
      { platform: "expedia_retrieval" },
      { $set: { platform: OtpPlatform.Expedia } }
    );
  }

  private async migrateLaneKeys(): Promise<void> {
    const missing = await OtpStatus.find({
      $or: [
        { otp_lane_key: { $exists: false } },
        { otp_lane_key: null },
        { otp_lane_key: "" },
      ],
    }).lean();

    for (let i = 0; i < missing.length; i++) {
      const doc = missing[i];
      const key =
        i === 0
          ? DEFAULT_BOOKING_OTP_LANE
          : `legacy_${String(doc._id)}`;
      await OtpStatus.updateOne(
        { _id: doc._id },
        { $set: { otp_lane_key: key } }
      );
    }
  }

  private async ensureDefaultLaneDoc(): Promise<void> {
    const envPlatform = this.getOtpDbPlatform();
    if (envPlatform === OtpPlatform.Booking) {
      return;
    }
    const existing = await OtpStatus.findOne({
      platform: envPlatform,
      otp_lane_key: DEFAULT_BOOKING_OTP_LANE,
    });
    if (!existing) {
      await OtpStatus.create({
        status: OtpStatusValue.Released,
        platform: envPlatform,
        job_id: null,
        otp_lane_key: DEFAULT_BOOKING_OTP_LANE,
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
      await this.migrateLaneKeys();
      await this.ensureDefaultLaneDoc();
      await this.syncCurrentStatusFromDb();
      this.isInitialized = true;
      console.log("OTP Status Manager initialized (per-lane):", this.currentStatus);
    } catch (error) {
      console.error("Failed to initialize OTP Status Manager:", error);
      throw error;
    }
  }

  public getCurrentStatus(): OtpStatusInfo | null {
    return this.currentStatus;
  }

  /**
   * True if the default lane is free (backward compatible “global” check).
   */
  public async isOtpAvailable(): Promise<boolean> {
    return this.isOtpAvailableForLane(
      this.getOtpDbPlatform(),
      DEFAULT_BOOKING_OTP_LANE
    );
  }

  /**
   * True if this phone/slot lane has no active OTP holder (or row does not exist yet).
   */
  public async isOtpAvailableForLane(
    _platform: OtpPlatform,
    laneKey: string
  ): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const key = this.normalizeLaneKey(laneKey);
    const doc = await OtpStatus.findOne({
      platform: this.getOtpDbPlatform(),
      otp_lane_key: key,
    }).lean();

    if (!doc) {
      return true;
    }
    return doc.status === OtpStatusValue.Released;
  }

  private async ensureLaneRow(laneKey: string): Promise<void> {
    const key = this.normalizeLaneKey(laneKey);
    const envPlatform = this.getOtpDbPlatform();
    await OtpStatus.updateOne(
      { platform: envPlatform, otp_lane_key: key },
      {
        $setOnInsert: {
          status: OtpStatusValue.Released,
          platform: envPlatform,
          otp_lane_key: key,
          job_id: null,
        },
      },
      { upsert: true }
    );
  }

  /**
   * Reserve OTP for a job on a lane (phone+slot for booking, "default" otherwise).
   */
  public async reserveOtp(
    jobId: string,
    _platform: OtpPlatform,
    laneKey: string = DEFAULT_BOOKING_OTP_LANE
  ): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!Types.ObjectId.isValid(jobId)) {
      console.error(`reserveOtp: invalid jobId ${jobId}`);
      return false;
    }

    const key = this.normalizeLaneKey(laneKey);
    const envPlatform = this.getOtpDbPlatform();

    try {
      await this.ensureLaneRow(key);

      const result = await OtpStatus.findOneAndUpdate(
        {
          status: OtpStatusValue.Released,
          platform: envPlatform,
          otp_lane_key: key,
        },
        {
          status: OtpStatusValue.Occupied,
          platform: envPlatform,
          otp_lane_key: key,
          job_id: new mongoose.Types.ObjectId(jobId),
        },
        { new: true }
      );

      if (result) {
        await this.syncCurrentStatusFromDb();
        console.log(
          `OTP reserved for job ${jobId} lane "${key}" (${envPlatform})`
        );
        this.emit("otpReserved", jobId, envPlatform);
        return true;
      }

      console.log(
        `Failed to reserve OTP for job ${jobId} lane "${key}" — lane busy`
      );
      return false;
    } catch (error) {
      console.error(`Error reserving OTP for job ${jobId}:`, error);
      return false;
    }
  }

  /**
   * Release the lane held by this job (matches job_id).
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
   * Visibility mirror for Booking: same moment as `phone_number_slots` reserve (lease `jobId` for groups).
   * Does not gate concurrency — locking stays on `phone_number_slots`.
   */
  public async setBookingOtpMirrorOccupied(
    jobId: string,
    phone_number: string,
    slot: number
  ): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    if (!Types.ObjectId.isValid(jobId)) {
      return;
    }
    const key = this.normalizeLaneKey(`booking:${phone_number}:${slot}`);
    try {
      await OtpStatus.updateOne(
        { platform: OtpPlatform.Booking, otp_lane_key: key },
        {
          $set: {
            status: OtpStatusValue.Occupied,
            job_id: new mongoose.Types.ObjectId(jobId),
            platform: OtpPlatform.Booking,
            otp_lane_key: key,
          },
        },
        { upsert: true }
      );
      await this.syncCurrentStatusFromDb();
      this.emit("otpReserved", jobId, OtpPlatform.Booking);
    } catch (error) {
      console.error(
        `[OtpStatus] setBookingOtpMirrorOccupied failed for job ${jobId}:`,
        error
      );
    }
  }

  /** Clear Booking mirror row(s) for this job id (lease id for `booking-run-group`). */
  public async releaseBookingOtpMirrorByJobId(jobId: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    if (!Types.ObjectId.isValid(jobId)) {
      return;
    }
    try {
      const oid = new mongoose.Types.ObjectId(jobId);
      const r = await OtpStatus.updateMany(
        { platform: OtpPlatform.Booking, job_id: oid },
        {
          $set: {
            status: OtpStatusValue.Released,
            job_id: null,
          },
        }
      );
      if (r.modifiedCount > 0) {
        await this.syncCurrentStatusFromDb();
        this.emit("otpReleased", jobId);
      }
    } catch (error) {
      console.error(
        `[OtpStatus] releaseBookingOtpMirrorByJobId failed for job ${jobId}:`,
        error
      );
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
        `\x1b[32m[OTP] All OTP lanes force-released — emitting 'otpReleased'\x1b[0m`
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
