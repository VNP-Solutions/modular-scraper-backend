import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for the PropertyCredentials document
export interface IPropertyCredentials extends Document {
  _id: Types.ObjectId;
  property_id: Types.ObjectId;
  expediaUsername?: string;
  expediaPassword?: string;
  agodaUsername?: string;
  agodaPassword?: string;
  bookingUsername?: string;
  bookingPassword?: string;
  expediaEmailAssociated?: string;
  propertyContactEmail?: string;
  portfolioContactEmail?: string;
  multiplePortfolioEmails: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Mongoose Schema for PropertyCredentials
const PropertyCredentialsSchema = new Schema<IPropertyCredentials>(
  {
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: true,
    },
    expediaUsername: {
      type: String,
      required: false,
    },
    expediaPassword: {
      type: String,
      required: false,
    },
    agodaUsername: {
      type: String,
      required: false,
    },
    agodaPassword: {
      type: String,
      required: false,
    },
    bookingUsername: {
      type: String,
      required: false,
    },
    bookingPassword: {
      type: String,
      required: false,
    },
    expediaEmailAssociated: {
      type: String,
      required: false,
    },
    propertyContactEmail: {
      type: String,
      required: false,
    },
    portfolioContactEmail: {
      type: String,
      required: false,
    },
    multiplePortfolioEmails: {
      type: [String],
      required: false,
      default: [],
    },
  },
  {
    timestamps: true,
    collection: "property_credentials",
  }
);

// Indexes
PropertyCredentialsSchema.index({ property_id: 1 });
PropertyCredentialsSchema.index({ property_id: 1 }, { unique: true }); // Ensure one credential per property

export const PropertyCredentials = mongoose.model<IPropertyCredentials>(
  "PropertyCredentials",
  PropertyCredentialsSchema
);
