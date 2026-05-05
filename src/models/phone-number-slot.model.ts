import mongoose, { Document, Schema, Types } from "mongoose";

/**
 * Lifecycle of a phone number slot. The scraper only reads from this collection,
 * but we still need the enum to type incoming docs correctly.
 *
 * - `Released`: free to be assigned to a property
 * - `Assigned`: tied to a property (and possibly a job) and not free to use
 * - `Locked`:   currently in use by a running job (mid-OTP)
 */
export enum PhoneNumberSlotStatus {
  Released = "Released",
  Assigned = "Assigned",
  Locked = "Locked",
}

export interface IPhoneNumberSlot extends Document {
  _id: Types.ObjectId;
  phone_number: string;
  slot: number;
  status: PhoneNumberSlotStatus;
  job_id?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PhoneNumberSlotSchema = new Schema<IPhoneNumberSlot>(
  {
    phone_number: {
      type: String,
      required: true,
    },
    slot: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(PhoneNumberSlotStatus),
      default: PhoneNumberSlotStatus.Released,
      required: true,
    },
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: false,
    },
  },
  {
    timestamps: true,
    collection: "phone_number_slots",
  }
);

PhoneNumberSlotSchema.index({ job_id: 1 });
PhoneNumberSlotSchema.index({ phone_number: 1 });
PhoneNumberSlotSchema.index({ status: 1 });
PhoneNumberSlotSchema.index({ phone_number: 1, slot: 1 });

export const PhoneNumberSlot = mongoose.model<IPhoneNumberSlot>(
  "PhoneNumberSlot",
  PhoneNumberSlotSchema
);
