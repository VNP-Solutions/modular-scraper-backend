import mongoose, { Types } from "mongoose";
import {
  IPhoneNumberSlot,
  PhoneNumberSlot,
  PhoneNumberSlotStatus,
} from "../models/phone-number-slot.model.js";

function normalizePhoneForSlot(phone: string | undefined): string {
  if (!phone) {
    return "default";
  }
  const digits = String(phone).replace(/\D/g, "");
  return digits || "default";
}

function slotFromPort(port: string | undefined): number {
  if (port == null || String(port).trim() === "") {
    return 0;
  }
  const n = parseInt(String(port).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Match import rows whether DB stores 10- or 11-digit US-style keys. */
function phoneVariantsForLookup(digits: string): string[] {
  if (!digits || digits === "default") {
    return ["default"];
  }
  const v = new Set<string>([digits]);
  if (digits.length === 10) {
    v.add(`1${digits}`);
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    v.add(digits.slice(1));
  }
  return [...v];
}

/**
 * Lane lookup fallback: match `phone_number` field by last 3 digits only (any formatting).
 * Assumes last-3 is unique across your OTP lines; if two full numbers share last 3, they collide.
 */
function digitsOnlyKey(phone_number: string): string {
  return String(phone_number).replace(/\D/g, "");
}

function lastThreeForMatch(phone_number: string): string | null {
  if (!phone_number || phone_number === "default") {
    return null;
  }
  const d = digitsOnlyKey(phone_number);
  if (d.length === 0) {
    return null;
  }
  return d.length >= 3 ? d.slice(-3) : d;
}

/** Stored value may be "[571] 251-0412" — last three digit characters must be d1,d2,d3 in order at end. */
function lastThreeSuffixRegex(last3: string): RegExp {
  const body = last3
    .split("")
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\D*");
  return new RegExp(`\\D*${body}$`, "i");
}

async function findLaneDocsByPhone(phone_number: string) {
  const variants = phoneVariantsForLookup(phone_number);
  const exact = await PhoneNumberSlot.find({
    phone_number: { $in: variants },
  }).lean();
  if (exact.length > 0) {
    return exact;
  }
  const last3 = lastThreeForMatch(phone_number);
  if (!last3) {
    return [];
  }
  return PhoneNumberSlot.find({
    phone_number: lastThreeSuffixRegex(last3),
  }).lean();
}

class PhoneNumberSlotService {
  getPhoneAndSlot(selectedContact?: {
    phone?: string;
    port?: string;
  }): { phone_number: string; slot: number } {
    return {
      phone_number: normalizePhoneForSlot(selectedContact?.phone),
      slot: slotFromPort(selectedContact?.port),
    };
  }

  /**
   * At least one `phone_number_slots` row for this phone exists and is Released,
   * and no row for this phone is Occupied.
   * Lock is per phone number only (port/slot does not define a separate lane).
   */
  async isPhoneLaneAvailable(phone_number: string): Promise<boolean> {
    const docs = await findLaneDocsByPhone(phone_number);
    if (docs.length === 0) {
      return false;
    }
    if (
      docs.some((d) => d.status === PhoneNumberSlotStatus.Occupied)
    ) {
      return false;
    }
    return docs.some((d) => d.status === PhoneNumberSlotStatus.Released);
  }

  async getPhoneLaneState(
    phone_number: string
  ): Promise<"missing" | "occupied" | "released"> {
    const docs = await findLaneDocsByPhone(phone_number);
    if (docs.length === 0) {
      return "missing";
    }
    if (docs.some((d) => d.status === PhoneNumberSlotStatus.Occupied)) {
      return "occupied";
    }
    if (docs.some((d) => d.status === PhoneNumberSlotStatus.Released)) {
      return "released";
    }
    return "occupied";
  }

  /**
   * Occupy one Released row for this phone (any matching `phone_number` variant).
   * Import should create row(s); we do not insert here.
   */
  async reservePhoneLane(
    jobId: string,
    phone_number: string
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(jobId)) {
      return false;
    }

    try {
      const variants = phoneVariantsForLookup(phone_number);
      const update = {
        status: PhoneNumberSlotStatus.Occupied,
        job_id: new mongoose.Types.ObjectId(jobId),
      };
      const opts = { new: true as const, sort: { slot: 1 } as const };

      let result = await PhoneNumberSlot.findOneAndUpdate(
        {
          phone_number: { $in: variants },
          status: PhoneNumberSlotStatus.Released,
        },
        update,
        opts
      );

      if (!result) {
        const last3 = lastThreeForMatch(phone_number);
        if (last3) {
          result = await PhoneNumberSlot.findOneAndUpdate(
            {
              phone_number: lastThreeSuffixRegex(last3),
              status: PhoneNumberSlotStatus.Released,
            },
            update,
            opts
          );
        }
      }

      if (result) {
        console.log(
          `PhoneNumberSlot reserved (by phone): ${result.phone_number} -> job ${jobId}`
        );
        return true;
      }

      const state = await this.getPhoneLaneState(phone_number);
      if (state === "missing") {
        console.warn(
          `PhoneNumberSlot.reservePhoneLane: no row for phone (digits ${variants.join(
            ", "
          )}) — create at job import`
        );
      }
      return false;
    } catch (error) {
      console.error("PhoneNumberSlot.reservePhoneLane error:", error);
      return false;
    }
  }

  /**
   * If this job holds an Occupied `phone_number_slots` row, return phone + port
   * for `setJobContact` (same shape as scraping OTP / worker pool).
   */
  async getOccupiedContactForJob(
    jobId: string
  ): Promise<{ phone: string; port: string } | null> {
    if (!mongoose.Types.ObjectId.isValid(jobId)) {
      return null;
    }
    try {
      const row = await PhoneNumberSlot.findOne({
        job_id: new mongoose.Types.ObjectId(jobId),
        status: PhoneNumberSlotStatus.Occupied,
      }).lean();
      if (!row) {
        return null;
      }
      return {
        phone: row.phone_number,
        port: String(row.slot),
      };
    } catch (error) {
      console.error("PhoneNumberSlot.getOccupiedContactForJob error:", error);
      return null;
    }
  }

  /**
   * Release the row held by this job (if any).
   */
  async releaseByJobId(jobId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(jobId)) {
      return false;
    }

    try {
      const result = await PhoneNumberSlot.findOneAndUpdate(
        { job_id: new mongoose.Types.ObjectId(jobId) },
        {
          status: PhoneNumberSlotStatus.Released,
          job_id: null,
        },
        { new: true }
      );
      return !!result;
    } catch (error) {
      console.error("PhoneNumberSlot.releaseByJobId error:", error);
      return false;
    }
  }

  async releaseAllOccupied(): Promise<number> {
    const r = await PhoneNumberSlot.updateMany(
      { status: PhoneNumberSlotStatus.Occupied },
      { status: PhoneNumberSlotStatus.Released, job_id: null }
    );
    return r.modifiedCount;
  }

  async listAll(): Promise<IPhoneNumberSlot[]> {
    return PhoneNumberSlot.find({}).lean();
  }
}

export const phoneNumberSlotService = new PhoneNumberSlotService();
