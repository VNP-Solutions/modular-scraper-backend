import mongoose, { Document, Schema, Types } from "mongoose";

// Embedded Types
export interface CardInfo {
  card_number: string; // Store encrypted or masked
  expiry_date: string;
  cvv?: string; // Optional or encrypted
  reason_for_charge?: string;
}

export interface PaymentInfo {
  total_guest_payment?: number;
  cancellation_fee?: number;
  total_payout?: number;
  amount_to_charge_or_refund: number; // Reverted back to number type
}

// Interface for the JobItem document
export interface IJobItem extends Document {
  _id: Types.ObjectId;
  job_id: Types.ObjectId;
  property_id: Types.ObjectId;
  guest_name: string;
  reservation_id: string;
  confirmation_number: string;
  check_in_date: Date;
  check_out_date: Date;
  room_type: string;
  booking_amount: number;
  booked_date: Date;
  has_card_info: boolean;
  card_info?: CardInfo;
  has_payment_info: boolean;
  payment_info?: PaymentInfo;
  reservation_status: string;
  additional_text?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Embedded schemas
const CardInfoSchema = new Schema<CardInfo>(
  {
    card_number: {
      type: String,
      required: true,
    },
    expiry_date: {
      type: String,
      required: true,
    },
    cvv: {
      type: String,
      required: false,
    },
    reason_for_charge: {
      type: String,
      required: false,
    },
  },
  { _id: false }
);

const PaymentInfoSchema = new Schema<PaymentInfo>(
  {
    total_guest_payment: {
      type: Number,
      required: true,
    },
    cancellation_fee: {
      type: Number,
      required: true,
    },
    total_payout: {
      type: Number,
      required: true,
    },
    amount_to_charge_or_refund: {
      type: Number,
      required: true,
    },
  },
  { _id: false }
);

// Main JobItem Schema
const JobItemSchema = new Schema<IJobItem>(
  {
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: true,
    },
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: true,
    },
    guest_name: {
      type: String,
      required: true,
    },
    reservation_id: {
      type: String,
      required: true,
    },
    confirmation_number: {
      type: String,
      required: true,
    },
    check_in_date: {
      type: Date,
      required: true,
    },
    check_out_date: {
      type: Date,
      required: true,
    },
    room_type: {
      type: String,
      required: true,
    },
    booking_amount: {
      type: Number,
      required: true,
    },
    booked_date: {
      type: Date,
      required: true,
    },
    has_card_info: {
      type: Boolean,
      default: false,
      required: true,
    },
    card_info: {
      type: CardInfoSchema,
      required: false,
    },
    has_payment_info: {
      type: Boolean,
      default: false,
      required: true,
    },
    payment_info: {
      type: PaymentInfoSchema,
      required: false,
    },
    reservation_status: {
      type: String,
      required: true,
    },
    additional_text: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: true,
    collection: "job_items",
  }
);

// Indexes for efficient queries
JobItemSchema.index({ job_id: 1 });
JobItemSchema.index({ property_id: 1 });
JobItemSchema.index({ reservation_id: 1 });
JobItemSchema.index({ confirmation_number: 1 });
JobItemSchema.index({ job_id: 1, property_id: 1 });
JobItemSchema.index({ guest_name: 1 });
JobItemSchema.index({ check_in_date: 1 });
JobItemSchema.index({ reservation_status: 1 });

// Compound index for unique constraint
JobItemSchema.index({ job_id: 1, reservation_id: 1 }, { unique: true });

export const JobItem = mongoose.model<IJobItem>("JobItem", JobItemSchema);
