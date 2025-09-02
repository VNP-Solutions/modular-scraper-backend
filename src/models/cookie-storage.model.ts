import mongoose, { Document, Schema, Types } from "mongoose";
import { PlatformsType } from "../common/booking-error-types";

// Interface for the CookieStorage document
export interface ICookieStorage extends Document {
  _id: Types.ObjectId;
  property_id: Types.ObjectId;
  platform: PlatformsType;
  cookies_data: string; // Encrypted JSON string of cookies
  expires_at?: Date;
  last_used: Date;
  is_active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Mongoose Schema for CookieStorage
const CookieStorageSchema = new Schema<ICookieStorage>(
  {
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: true,
    },
    platform: {
      type: String,
      enum: Object.values(PlatformsType),
      required: true,
    },
    cookies_data: {
      type: String,
      required: true,
    },
    expires_at: {
      type: Date,
      required: false,
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
  },
  {
    timestamps: true,
    collection: "cookie_storage",
  }
);

// Indexes for performance
CookieStorageSchema.index({ property_id: 1, platform: 1 }, { unique: true });
CookieStorageSchema.index({ property_id: 1 });
CookieStorageSchema.index({ platform: 1 });
CookieStorageSchema.index({ expires_at: 1 });
CookieStorageSchema.index({ is_active: 1 });

export const CookieStorage = mongoose.model<ICookieStorage>("CookieStorage", CookieStorageSchema); 