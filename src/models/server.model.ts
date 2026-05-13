import mongoose, { Document, Schema } from "mongoose";

export enum OtpPlatform {
  Expedia = "expedia_db",
  Agoda = "agoda_db",
}

export interface IServer extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  url: string;
  platform?: OtpPlatform;
  job_count: number;
  max_concurrent_jobs: number;
  is_active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const serverSchema = new Schema<IServer>(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    url: {
      type: String,
      required: true,
    },
    platform: {
      type: String,
      enum: Object.values(OtpPlatform),
      required: false,
    },
    job_count: {
      type: Number,
      default: 0,
    },
    max_concurrent_jobs: {
      type: Number,
      default: 200,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: "servers",
  }
);

export const Server = mongoose.model<IServer>("Server", serverSchema);
