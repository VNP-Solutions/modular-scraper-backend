import mongoose, { Document, Schema, Types } from "mongoose";

export enum OtpStatusValue {
  Occupied = "Occupied",
  Released = "Released",
}

export enum OtpPlatform {
  Expedia = "expedia",
  Agoda = "agoda",
  Booking = "booking",
}

export interface IOtpStatus extends Document {
  _id: Types.ObjectId;
  status: OtpStatusValue;
  platform?: OtpPlatform;
  /**
   * Lane id: Expedia/Agoda OTP mutex, or Booking **mirror** rows `booking:{phoneDigits}:{slot}`
   * (visibility only; Booking locking uses `phone_number_slots`).
   */
  otp_lane_key?: string;
  job_id?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const OtpStatusSchema = new Schema<IOtpStatus>(
  {
    status: {
      type: String,
      enum: Object.values(OtpStatusValue),
      required: true,
    },
    platform: {
      type: String,
      enum: Object.values(OtpPlatform),
      required: false,
    },
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: false,
    },
    otp_lane_key: {
      type: String,
      required: false,
      default: "default",
    },
  },
  {
    timestamps: true,
    collection: "otp_statuses",
  }
);

OtpStatusSchema.index({ platform: 1, otp_lane_key: 1 });

export const OtpStatus = mongoose.model<IOtpStatus>(
  "OtpStatus",
  OtpStatusSchema
);
