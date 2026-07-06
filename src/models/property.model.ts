import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for the Property document
export interface IProperty extends Document {
  _id: Types.ObjectId;
  name: string;
  card_descriptor?: string;
  is_active: boolean;
  next_due_date?: Date;
  portfolio_id: Types.ObjectId;

  // Service Type
  service_type_id?: Types.ObjectId;
  currency_id?: Types.ObjectId;
  subportfolio_id?: Types.ObjectId;
  previous_portfolio_id?: Types.ObjectId;
  show_in_portfolio: Types.ObjectId[];

  new_domain_email?: string;
  others_case_emails: string[];
  primary_case_email?: string;
  portfolio_contact_email?: string;
  portfolio_contact?: string;
  webmail_password?: string;
  description?: string;
  hotel_address?: string;
  property_identifier?: string;

  // Contact Information
  case_management_contact?: string;
  access_contact?: string;
  reporting_contact?: string;

  // OTA Processors
  expedia_processor_id?: Types.ObjectId;
  booking_processor_id?: Types.ObjectId;
  agoda_processor_id?: Types.ObjectId;

  // Date Range Fields (legacy)
  from?: string;
  to?: string;

  // QP / FP Credentials (passwords encrypted at application layer)
  qp_username?: string;
  qp_password?: string;
  qp_api_key?: string;
  fp_mid?: string;
  fp_username?: string;
  fp_password?: string;
  stripe_account_email?: string;

  // OTA Integration Fields
  expedia_id?: number;
  expedia_status?: string;
  booking_id?: number;
  booking_status?: string;
  agoda_id?: number;
  agoda_status?: string;

  // Expedia integration detail
  expedia_billing_type_id?: Types.ObjectId;
  expedia_service_type_id?: Types.ObjectId;
  expedia_frequency_id?: Types.ObjectId;
  expedia_access_level?: boolean;
  expedia_from?: string;
  expedia_to?: string;
  expedia_scheduler?: boolean;
  expedia_duration?: number;
  expedia_service_fee?: number;
  expedia_priority_id?: Types.ObjectId;
  expedia_crs?: string;
  expedia_crs_db?: string;
  expedia_run_date_from?: string;
  expedia_run_date_to?: string;
  expedia_run_date_db_from?: string;
  expedia_run_date_db_to?: string;
  expedia_revised_date?: string;
  expedia_scheduler_review_from?: string;
  expedia_scheduler_review_to?: string;
  expedia_scheduler_db?: string;
  expedia_scheduler_review_db_from?: string;
  expedia_scheduler_review_db_to?: string;
  expedia_db_duration?: number;
  expedia_credential_verified?: boolean;
  expedia_otp_number?: string;
  from_db?: string;
  to_db?: string;

  // Booking.com integration detail
  booking_billing_type_id?: Types.ObjectId;
  booking_service_type_id?: Types.ObjectId;
  booking_frequency_id?: Types.ObjectId;
  booking_access_level?: boolean;
  booking_from?: string;
  booking_to?: string;
  booking_scheduler?: boolean;
  booking_duration?: number;
  booking_service_fee?: number;
  booking_priority_id?: Types.ObjectId;
  booking_crs?: string;
  booking_run_date?: string;
  booking_revised_date?: string;
  booking_credential_verified?: boolean;
  booking_otp_number?: string;

  // Agoda integration detail
  agoda_billing_type_id?: Types.ObjectId;
  agoda_service_type_id?: Types.ObjectId;
  agoda_frequency_id?: Types.ObjectId;
  agoda_access_level?: boolean;
  agoda_from?: string;
  agoda_to?: string;
  agoda_scheduler?: boolean;
  agoda_duration?: number;
  agoda_service_fee?: number;
  agoda_priority_id?: Types.ObjectId;
  agoda_crs?: string;
  agoda_run_date?: string;
  agoda_revised_date?: string;
  agoda_credential_verified?: boolean;
  agoda_otp_number?: string;

  sales_rep?: string;

  // OTA Configuration
  need_another_domain?: boolean;
  booking_otp_phone?: string;

  created_at: Date;
  updated_at: Date;
}

// Mongoose Schema for Property
const PropertySchema = new Schema<IProperty>(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    card_descriptor: { type: String, required: false },
    is_active: { type: Boolean, default: true },
    next_due_date: { type: Date, required: false },
    portfolio_id: {
      type: Schema.Types.ObjectId,
      ref: "Portfolio",
      required: true,
    },

    // Service Type
    service_type_id: {
      type: Schema.Types.ObjectId,
      ref: "ServiceType",
      required: false,
    },
    currency_id: {
      type: Schema.Types.ObjectId,
      ref: "Currency",
      required: false,
    },
    subportfolio_id: {
      type: Schema.Types.ObjectId,
      ref: "Subportfolio",
      required: false,
    },
    previous_portfolio_id: {
      type: Schema.Types.ObjectId,
      required: false,
    },
    show_in_portfolio: {
      type: [Schema.Types.ObjectId],
      default: [],
    },

    new_domain_email: { type: String, required: false },
    others_case_emails: { type: [String], default: [] },
    primary_case_email: { type: String, required: false },
    portfolio_contact_email: { type: String, required: false },
    portfolio_contact: { type: String, required: false },
    webmail_password: { type: String, required: false },
    description: { type: String, required: false },
    hotel_address: { type: String, required: false },
    property_identifier: { type: String, required: false },

    // Contact Information
    case_management_contact: { type: String, required: false },
    access_contact: { type: String, required: false },
    reporting_contact: { type: String, required: false },

    // OTA Processors
    expedia_processor_id: {
      type: Schema.Types.ObjectId,
      ref: "Processor",
      required: false,
    },
    booking_processor_id: {
      type: Schema.Types.ObjectId,
      ref: "Processor",
      required: false,
    },
    agoda_processor_id: {
      type: Schema.Types.ObjectId,
      ref: "Processor",
      required: false,
    },

    // Date Range Fields (legacy)
    from: { type: String, required: false },
    to: { type: String, required: false },

    // QP / FP Credentials (passwords encrypted at application layer)
    qp_username: { type: String, required: false },
    qp_password: { type: String, required: false },
    qp_api_key: { type: String, required: false },
    fp_mid: { type: String, required: false },
    fp_username: { type: String, required: false },
    fp_password: { type: String, required: false },
    stripe_account_email: { type: String, required: false },

    // OTA Integration Fields
    expedia_id: { type: Number, required: false },
    expedia_status: { type: String, required: false },
    booking_id: { type: Number, required: false },
    booking_status: { type: String, required: false },
    agoda_id: { type: Number, required: false },
    agoda_status: { type: String, required: false },

    // Expedia integration detail
    expedia_billing_type_id: {
      type: Schema.Types.ObjectId,
      ref: "BillingType",
      required: false,
    },
    expedia_service_type_id: {
      type: Schema.Types.ObjectId,
      ref: "ServiceType",
      required: false,
    },
    expedia_frequency_id: {
      type: Schema.Types.ObjectId,
      ref: "Frequency",
      required: false,
    },
    expedia_access_level: { type: Boolean, required: false },
    expedia_from: { type: String, required: false },
    expedia_to: { type: String, required: false },
    expedia_scheduler: { type: Boolean, required: false },
    expedia_duration: { type: Number, required: false },
    expedia_service_fee: { type: Number, required: false },
    expedia_priority_id: {
      type: Schema.Types.ObjectId,
      ref: "Priority",
      required: false,
    },
    expedia_crs: { type: String, required: false },
    expedia_crs_db: { type: String, required: false },
    expedia_run_date_from: { type: String, required: false },
    expedia_run_date_to: { type: String, required: false },
    expedia_run_date_db_from: { type: String, required: false },
    expedia_run_date_db_to: { type: String, required: false },
    expedia_revised_date: { type: String, required: false },
    expedia_scheduler_review_from: { type: String, required: false },
    expedia_scheduler_review_to: { type: String, required: false },
    expedia_scheduler_db: { type: String, required: false },
    expedia_scheduler_review_db_from: { type: String, required: false },
    expedia_scheduler_review_db_to: { type: String, required: false },
    expedia_db_duration: { type: Number, required: false },
    expedia_credential_verified: { type: Boolean, required: false },
    expedia_otp_number: { type: String, required: false },
    from_db: { type: String, required: false },
    to_db: { type: String, required: false },

    // Booking.com integration detail
    booking_billing_type_id: {
      type: Schema.Types.ObjectId,
      ref: "BillingType",
      required: false,
    },
    booking_service_type_id: {
      type: Schema.Types.ObjectId,
      ref: "ServiceType",
      required: false,
    },
    booking_frequency_id: {
      type: Schema.Types.ObjectId,
      ref: "Frequency",
      required: false,
    },
    booking_access_level: { type: Boolean, required: false },
    booking_from: { type: String, required: false },
    booking_to: { type: String, required: false },
    booking_scheduler: { type: Boolean, required: false },
    booking_duration: { type: Number, required: false },
    booking_service_fee: { type: Number, required: false },
    booking_priority_id: {
      type: Schema.Types.ObjectId,
      ref: "Priority",
      required: false,
    },
    booking_crs: { type: String, required: false },
    booking_run_date: { type: String, required: false },
    booking_revised_date: { type: String, required: false },
    booking_credential_verified: { type: Boolean, required: false },
    booking_otp_number: { type: String, required: false },

    // Agoda integration detail
    agoda_billing_type_id: {
      type: Schema.Types.ObjectId,
      ref: "BillingType",
      required: false,
    },
    agoda_service_type_id: {
      type: Schema.Types.ObjectId,
      ref: "ServiceType",
      required: false,
    },
    agoda_frequency_id: {
      type: Schema.Types.ObjectId,
      ref: "Frequency",
      required: false,
    },
    agoda_access_level: { type: Boolean, required: false },
    agoda_from: { type: String, required: false },
    agoda_to: { type: String, required: false },
    agoda_scheduler: { type: Boolean, required: false },
    agoda_duration: { type: Number, required: false },
    agoda_service_fee: { type: Number, required: false },
    agoda_priority_id: {
      type: Schema.Types.ObjectId,
      ref: "Priority",
      required: false,
    },
    agoda_crs: { type: String, required: false },
    agoda_run_date: { type: String, required: false },
    agoda_revised_date: { type: String, required: false },
    agoda_credential_verified: { type: Boolean, required: false },
    agoda_otp_number: { type: String, required: false },

    sales_rep: { type: String, required: false },

    // OTA Configuration
    need_another_domain: { type: Boolean, required: false },
    booking_otp_phone: { type: String, required: false },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "Property",
  }
);

// Indexes (mirrors the Prisma schema)
PropertySchema.index({ portfolio_id: 1 });
PropertySchema.index({ subportfolio_id: 1 });
PropertySchema.index({ service_type_id: 1 });
PropertySchema.index({ currency_id: 1 });
PropertySchema.index({ expedia_priority_id: 1 });
PropertySchema.index({ booking_priority_id: 1 });
PropertySchema.index({ agoda_priority_id: 1 });
PropertySchema.index({ is_active: 1 });
PropertySchema.index({ next_due_date: 1 });
PropertySchema.index({ portfolio_id: 1, is_active: 1 });
PropertySchema.index({ expedia_id: 1 });
PropertySchema.index({ booking_id: 1 });
PropertySchema.index({ agoda_id: 1 });

export const Property = mongoose.model<IProperty>("Property", PropertySchema);
