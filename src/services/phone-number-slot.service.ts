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

  async isSlotAvailable(
    phone_number: string,
    slot: number
  ): Promise<boolean> {
    const doc = await PhoneNumberSlot.findOne({ phone_number, slot }).lean();
    if (!doc) {
      return true;
    }
    return doc.status === PhoneNumberSlotStatus.Released;
  }

  private async ensureReleasedRow(
    phone_number: string,
    slot: number
  ): Promise<void> {
    await PhoneNumberSlot.updateOne(
      { phone_number, slot },
      {
        $setOnInsert: {
          phone_number,
          slot,
          status: PhoneNumberSlotStatus.Released,
          job_id: null,
        },
      },
      { upsert: true }
    );
  }

  /**
   * Atomically occupy this phone+slot for jobId. Other jobs must wait until releaseByJobId.
   */
  async reserveSlot(
    jobId: string,
    phone_number: string,
    slot: number
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(jobId)) {
      return false;
    }

    try {
      await this.ensureReleasedRow(phone_number, slot);

      const result = await PhoneNumberSlot.findOneAndUpdate(
        {
          phone_number,
          slot,
          status: PhoneNumberSlotStatus.Released,
        },
        {
          status: PhoneNumberSlotStatus.Occupied,
          job_id: new mongoose.Types.ObjectId(jobId),
        },
        { new: true }
      );

      if (result) {
        console.log(
          `PhoneNumberSlot reserved: ${phone_number} slot ${slot} -> job ${jobId}`
        );
        return true;
      }
      return false;
    } catch (error) {
      console.error("PhoneNumberSlot.reserveSlot error:", error);
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
