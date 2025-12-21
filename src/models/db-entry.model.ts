import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for the DB Data document
export interface IDbEntry extends Document {
  _id: Types.ObjectId;
  job_id: Types.ObjectId;
  property_name: string;
  property_id: string;
  db_data_id: Types.ObjectId;
  reservation_id: string;
  invoice_id: string;
  guest_name: string;
  check_in_date: Date;
  check_out_date: Date;
  previously_paid_amount: number;
  previously_paid_amount_currency: string;
  maximum_billable_amount: number;
  maximum_billable_amount_currency: string;
  requested_booking_amount: number;
  requested_taxes: number;
  requested_total: number;
  requested_total_currency: string;
  created_at: Date;
  updated_at: Date;
}

// Schema definition
const DbEntrySchema = new Schema<IDbEntry>(
  {
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: true,
      index: true,
    },
    property_name: {
      type: String,
      required: true,
    },
    property_id: {
      type: String,
      required: true,
      index: true,
    },
    db_data_id: {
      type: Schema.Types.ObjectId,
      ref: "DbData",
      required: true,
      index: true,
    },
    reservation_id: {
      type: String,
      required: true,
      index: true,
    },
    invoice_id: {
      type: String,
      required: true,
      index: true,
    },
    guest_name: {
      type: String,
      required: true,
      index: true,
    },
    check_in_date: {
      type: Date,
      required: true,
      index: true,
    },
    check_out_date: {
      type: Date,
      required: true,
      index: true,
    },
    previously_paid_amount: {
      type: Number,
      required: true,
      index: true,
    },
    previously_paid_amount_currency: {
      type: String,
      required: true,
      index: true,
    },
    maximum_billable_amount: {
      type: Number,
      required: true,
      index: true,
    },
    maximum_billable_amount_currency: {
      type: String,
      required: true,
      index: true,
    },
    requested_booking_amount: {
      type: Number,
      required: true,
      index: true,
    },
    requested_taxes: {
      type: Number,
      required: true,
      index: true,
    },
    requested_total: {
      type: Number,
      required: true,
      index: true,
    },
    requested_total_currency: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    collection: "db_entries", // Explicitly set collection name
  }
);

// Export the model
export const DbEntry = mongoose.model<IDbEntry>("DbEntry", DbEntrySchema);
