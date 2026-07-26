import mongoose, { Document, Schema, Types } from "mongoose";
import { IPropertyCredentials } from "./Property-credentials";

// Enum for booking trust status
export enum BookingTrustedStatus {
  NotTrusted = "not_trusted",
  Trusted = "trusted",
}

// Interface for the Property document
export interface IProperty extends Document {
  _id: Types.ObjectId;
  expedia_id: string;
  booking_id: number;
  agoda_id: string;
  property_name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  zip_code?: string;
  phone?: string;
  email?: string;
  website?: string;
  property_type?: string;
  status: string;
  created_by: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  user_email?: string;
  user_password?: string;
  booking_trusted_status?: BookingTrustedStatus;
  booking_last_login?: Date;
  parent_id?: string;

  credentials?: IPropertyCredentials[];
}

function isValidId(value: string | number): boolean {
  if (!value) return false;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string" && value.trim() === "") return false;

  return true;
}

// Mongoose Schema for Property
const PropertySchema = new Schema<IProperty>(
  {
    expedia_id: {
      type: String,
      required: false,
    },
    booking_id: {
      type: Number,
      required: false,
    },
    agoda_id: {
      type: String,
      required: false,
    },
    property_name: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      required: false,
    },
    city: {
      type: String,
      required: false,
    },
    state: {
      type: String,
      required: false,
    },
    country: {
      type: String,
      required: false,
    },
    zip_code: {
      type: String,
      required: false,
    },
    phone: {
      type: String,
      required: false,
    },
    email: {
      type: String,
      required: false,
    },
    website: {
      type: String,
      required: false,
    },
    property_type: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      required: true,
      default: "active",
    },
    created_by: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    user_email: {
      type: String,
      required: false,
    },
    user_password: {
      type: String,
      required: false,
    },
    // Booking trust tracking fields
    booking_trusted_status: {
      type: String,
      enum: Object.values(BookingTrustedStatus),
      default: BookingTrustedStatus.NotTrusted,
      required: false,
    },
    booking_last_login: {
      type: Date,
      required: false,
    },
    parent_id: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: true,
    collection: "properties",
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
PropertySchema.index({ created_by: 1 });
PropertySchema.index({ status: 1 });
PropertySchema.index({ property_name: 1 });
// Booking trust scheduling indexes
PropertySchema.index({ booking_trusted_status: 1, booking_last_login: 1 });
PropertySchema.index({ booking_id: 1, booking_trusted_status: 1 });

// Virtual for credentials
PropertySchema.virtual("credentials", {
  ref: "PropertyCredentials",
  localField: "_id",
  foreignField: "property_id",
  justOne: false,
});

export const Property = mongoose.model<IProperty>("Property", PropertySchema);
