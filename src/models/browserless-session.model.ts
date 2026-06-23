import mongoose, { Document, Schema } from "mongoose";
import { PlatformsType } from "../common/booking-error-types.js";

export interface IBrowserlessSession extends Document {
  email: string;
  platform: PlatformsType;
  session_id: string;
  connect_url: string;
  stop_url: string;
  browserql_url?: string;
  ttl: number;
  expires_at: Date;
  last_used: Date;
  is_active: boolean;
  cloud_endpoint_id?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const BrowserlessSessionSchema = new Schema<IBrowserlessSession>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    platform: {
      type: String,
      enum: Object.values(PlatformsType),
      required: true,
      default: PlatformsType.BOOKING,
    },
    session_id: {
      type: String,
      required: true,
    },
    connect_url: {
      type: String,
      required: true,
    },
    stop_url: {
      type: String,
      required: true,
    },
    browserql_url: {
      type: String,
      required: false,
    },
    ttl: {
      type: Number,
      required: true,
    },
    expires_at: {
      type: Date,
      required: true,
    },
    last_used: {
      type: Date,
      default: Date.now,
      required: true,
    },
    is_active: {
      type: Boolean,
      default: true,
      required: true,
    },
    cloud_endpoint_id: {
      type: String,
      required: false,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "browserless_sessions",
  }
);

BrowserlessSessionSchema.index({ email: 1, platform: 1 }, { unique: true });
BrowserlessSessionSchema.index({ session_id: 1 });
BrowserlessSessionSchema.index({ expires_at: 1 });
BrowserlessSessionSchema.index({ is_active: 1 });

export const BrowserlessSession = mongoose.model<IBrowserlessSession>(
  "BrowserlessSession",
  BrowserlessSessionSchema
);
