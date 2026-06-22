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
  expediaSecondaryUsername?: string;
  expediaSecondaryPassword?: string;
  bookingSecondaryUsername?: string;
  bookingSecondaryPassword?: string;
  agodaSecondaryUsername?: string;
  agodaSecondaryPassword?: string;
  expediaEmailAssociated?: string;
  propertyContactEmail?: string;
  portfolioContactEmail?: string;
  multiplePortfolioEmails: string[];

  case_contact_email?: string;
  case_contact_name?: string;
  case_contact_phone?: string;

  reporting_contact_name?: string;
  reporting_contact_email?: string;
  reporting_contact_phone?: string;

  created_at: Date;
  updated_at: Date;
}

// Mongoose Schema for PropertyCredentials
const PropertyCredentialsSchema = new Schema<IPropertyCredentials>(
  {
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: true,
    },
    expediaUsername: { type: String, required: false },
    expediaPassword: { type: String, required: false },
    agodaUsername: { type: String, required: false },
    agodaPassword: { type: String, required: false },
    bookingUsername: { type: String, required: false },
    bookingPassword: { type: String, required: false },
    expediaSecondaryUsername: { type: String, required: false },
    expediaSecondaryPassword: { type: String, required: false },
    bookingSecondaryUsername: { type: String, required: false },
    bookingSecondaryPassword: { type: String, required: false },
    agodaSecondaryUsername: { type: String, required: false },
    agodaSecondaryPassword: { type: String, required: false },
    expediaEmailAssociated: { type: String, required: false },
    propertyContactEmail: { type: String, required: false },
    portfolioContactEmail: { type: String, required: false },
    multiplePortfolioEmails: {
      type: [String],
      required: false,
      default: [],
    },

    case_contact_email: { type: String, required: false },
    case_contact_name: { type: String, required: false },
    case_contact_phone: { type: String, required: false },

    reporting_contact_name: { type: String, required: false },
    reporting_contact_email: { type: String, required: false },
    reporting_contact_phone: { type: String, required: false },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "property_credentials",
  }
);

// Index (a property can have multiple credential records → non-unique)
PropertyCredentialsSchema.index({ property_id: 1 });

export const PropertyCredentials = mongoose.model<IPropertyCredentials>(
  "PropertyCredentials",
  PropertyCredentialsSchema
);
