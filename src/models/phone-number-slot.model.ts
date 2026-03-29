import mongoose, { Document, Schema, Types } from "mongoose";

export enum PhoneNumberSlotStatus {
  Occupied = "Occupied",
  Released = "Released",
}

export interface IPhoneNumberSlot extends Document {
  _id: Types.ObjectId;
  phone_number: string;
  slot: number;
  status: PhoneNumberSlotStatus;
  job_id?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const PhoneNumberSlotSchema = new Schema<IPhoneNumberSlot>(
  {
    phone_number: { type: String, required: true },
    slot: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(PhoneNumberSlotStatus),
      default: PhoneNumberSlotStatus.Released,
    },
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: false,
      default: null,
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
PhoneNumberSlotSchema.index({ phone_number: 1, slot: 1 }, { unique: true });

export const PhoneNumberSlot = mongoose.model<IPhoneNumberSlot>(
  "PhoneNumberSlot",
  PhoneNumberSlotSchema
);
