import dotenv from "dotenv";
import { EventEmitter } from "events";
import { Types } from "mongoose";
import { OtpStatusValue } from "../models/otp-status.model.js";
import {
  PhoneNumberSlot,
  PhoneNumberSlotStatus,
  IPhoneNumberSlot,
} from "../models/phone-number-slot.model.js";
import { phoneNumberSlotService } from "../services/phone-number-slot.service.js";
import { getBookingPhoneForLock } from "./booking-otp-lane.js";

dotenv.config();

export type BookingSelectedContact = {
  phone?: string;
  port?: string;
};

/**
 * High-level occupancy snapshot. Worker pool locks one OTP lane per phone number
 * (`phone_number_slots`); use `getDetailedStatus()` for per-row truth.
 */
export interface OtpStatusInfo {
  status: OtpStatusValue;
  /** Job holding a slot when `Occupied` (newest occupied row); null when all released. */
  jobId: string | null;
  lastUpdated: Date;
}

let instance: OtpStatusManager | null = null;

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

  private async syncCurrentStatusFromDb(): Promise<void> {
    const occupied = await PhoneNumberSlot.findOne({
      status: PhoneNumberSlotStatus.Occupied,
    })
      .sort({ updatedAt: -1 })
      .lean();

    if (occupied) {
      this.currentStatus = {
        status: OtpStatusValue.Occupied,
        jobId: occupied.job_id?.toString() || null,
        lastUpdated: occupied.updatedAt,
      };
      return;
    }

    this.currentStatus = {
      status: OtpStatusValue.Released,
      jobId: null,
      lastUpdated: new Date(),
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await this.syncCurrentStatusFromDb();
      this.isInitialized = true;
      console.log(
        "OTP Status Manager initialized (Booking phone_number_slots):",
        this.currentStatus
      );
    } catch (error) {
      console.error("Failed to initialize OTP Status Manager:", error);
      throw error;
    }
  }

  public getCurrentStatus(): OtpStatusInfo | null {
    return this.currentStatus;
  }

  /**
   * Whether this phone number's lane is free (Released row exists, none Occupied for that phone).
   */
  public async isBookingSlotAvailable(
    selectedContact?: BookingSelectedContact
  ): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    const { phone_number } = getBookingPhoneForLock({ selectedContact });
    return phoneNumberSlotService.isPhoneLaneAvailable(phone_number);
  }

  public async getBookingPhoneLaneDiagnostics(
    selectedContact?: BookingSelectedContact
  ): Promise<{
    phone_number: string;
    state: "missing" | "occupied" | "released";
  }> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    const { phone_number } = getBookingPhoneForLock({ selectedContact });
    const state = await phoneNumberSlotService.getPhoneLaneState(phone_number);
    return { phone_number, state };
  }

  /**
   * Atomically occupy `phone_number_slots` for this job + contact (Booking OTP gate).
   */
  public async reserveBookingPhoneSlot(
    jobId: string,
    selectedContact?: BookingSelectedContact
  ): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!Types.ObjectId.isValid(jobId)) {
      console.error(`reserveBookingPhoneSlot: invalid jobId ${jobId}`);
      return false;
    }

    const { phone_number } = getBookingPhoneForLock({ selectedContact });

    try {
      const ok = await phoneNumberSlotService.reservePhoneLane(
        jobId,
        phone_number
      );
      if (ok) {
        await this.syncCurrentStatusFromDb();
        console.log(
          `PhoneNumberSlot reserved (OTP gate, by phone): ${phone_number} -> job ${jobId}`
        );
        this.emit("otpReserved", jobId);
      }
      return ok;
    } catch (error) {
      console.error(`Error reserving phone slot for job ${jobId}:`, error);
      return false;
    }
  }

  /**
   * Release the `phone_number_slots` row held by this job_id.
   */
  public async releaseOtp(jobId: string): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      if (!Types.ObjectId.isValid(jobId)) {
        return false;
      }

      const result = await phoneNumberSlotService.releaseByJobId(jobId);

      if (result) {
        await this.syncCurrentStatusFromDb();
        console.log(`\x1b[32mPhone slot released by job ${jobId}\x1b[0m`);
        this.emit("otpReleased", jobId);
        return true;
      }

      return true;
    } catch (error) {
      console.error(`Error releasing phone slot for job ${jobId}:`, error);
      return false;
    }
  }

  public async forceReleaseOtp(): Promise<boolean> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      await phoneNumberSlotService.releaseAllOccupied();
      await this.syncCurrentStatusFromDb();
      console.log(
        `\x1b[32m[OTP] All phone_number_slots force-released — emitting 'otpReleased'\x1b[0m`
      );
      this.emit("otpReleased", null);
      return true;
    } catch (error) {
      console.error("Error force releasing phone slots:", error);
      return false;
    }
  }

  public async getDetailedStatus(): Promise<IPhoneNumberSlot[]> {
    try {
      return await phoneNumberSlotService.listAll();
    } catch (error) {
      console.error("Error listing phone_number_slots:", error);
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
          this.emit("otpReserved", this.currentStatus.jobId);
        }
      }
    } catch (error) {
      console.error("Error refreshing OTP status from database:", error);
    }
  }
}

export const otpStatusManager = OtpStatusManager.getInstance();
