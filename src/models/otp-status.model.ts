import mongoose, { Document, Schema, Types } from "mongoose";

export enum OtpStatusValue {
  Occupied = "Occupied",
  Released = "Released",
}

export enum OtpPlatform {
  Expedia = "expedia",
  ExpediaRetrieval = "expedia_retrieval",
}

export interface IOtpStatus extends Document {
  _id: Types.ObjectId;
  status: OtpStatusValue;
  platform?: OtpPlatform;
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
    collection: "otp_statuses",
  }
);

// One OTP lock document per platform — prevents concurrent reserve races
OtpStatusSchema.index({ platform: 1 }, { unique: true });

export const OtpStatus = mongoose.model<IOtpStatus>(
  "OtpStatus",
  OtpStatusSchema
);
