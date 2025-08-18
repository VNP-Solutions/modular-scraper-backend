import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for the Property document
export interface IProperty extends Document {
  _id: Types.ObjectId;
  expedia_id?: string; // The actual Expedia property ID used for scraping
  agoda_id?: string; // The actual Agoda property ID used for scraping
  booking_id?: string; // The actual Booking property ID used for scraping
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
}

// Mongoose Schema for Property
const PropertySchema = new Schema<IProperty>(
  {
    expedia_id: {
      type: String,
      required: false,
      unique: true,
    },
    agoda_id: {
      type: String,
      required: false,
      unique: true,
    },
    booking_id: {
      type: String,
      required: false,
      unique: true,
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
  },
  {
    timestamps: true,
    collection: "properties",
  }
);

// Indexes
PropertySchema.index({ created_by: 1 });
PropertySchema.index({ status: 1 });
PropertySchema.index({ property_name: 1 });

export const Property = mongoose.model<IProperty>("Property", PropertySchema);
