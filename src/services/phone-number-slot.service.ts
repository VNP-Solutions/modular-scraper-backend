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
    const variants = phoneVariantsForLookup(phone_number);
    const docs = await PhoneNumberSlot.find({
      phone_number: { $in: variants },
    }).lean();
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
    const variants = phoneVariantsForLookup(phone_number);
    const docs = await PhoneNumberSlot.find({
      phone_number: { $in: variants },
    }).lean();
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
      const result = await PhoneNumberSlot.findOneAndUpdate(
        {
          phone_number: { $in: variants },
          status: PhoneNumberSlotStatus.Released,
        },
        {
          status: PhoneNumberSlotStatus.Occupied,
          job_id: new mongoose.Types.ObjectId(jobId),
        },
        { new: true, sort: { slot: 1 } }
      );

      if (result) {
        console.log(
          `PhoneNumberSlot reserved (by phone): ${result.phone_number} -> job ${jobId}`
        );
        return true;
      }

      const state = await this.getPhoneLaneState(phone_number);
      if (state === "missing") {
        console.warn(
          `PhoneNumberSlot.reservePhoneLane: no row for phone (variants ${variants.join(
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
