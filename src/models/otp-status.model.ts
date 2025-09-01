import mongoose, { Document, Schema, Types } from "mongoose";

export enum OtpStatusValue {
  Occupied = "Occupied",
  Released = "Released",
}

export interface IOtpStatus extends Document {
  _id: Types.ObjectId;
  status: OtpStatusValue;
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
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "otp_statuses",
  }
);

export const OtpStatus = mongoose.model<IOtpStatus>(
  "OtpStatus",
  OtpStatusSchema
);
