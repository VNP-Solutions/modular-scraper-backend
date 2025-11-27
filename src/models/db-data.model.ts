import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for the DB Data document
export interface IDbData extends Document {
  _id: Types.ObjectId;
  job_id: Types.ObjectId;
  property_name: string;
  property_id: string;
  date_range: {
    start_date: string;
    end_date: string;
  };
  gearbox_queue_ids: string[];
  total_invoice_amount: number;
  total_invoice_amount_currency?: string;
  created_at: Date;
  updated_at: Date;
}

// Schema definition
const DbDataSchema = new Schema<IDbData>(
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
    date_range: {
      start_date: {
        type: String,
        required: true,
      },
      end_date: {
        type: String,
        required: true,
      },
    },
    gearbox_queue_ids: {
      type: [String],
      default: [],
    },
    total_invoice_amount: {
      type: Number,
      required: true,
    },
    total_invoice_amount_currency: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    collection: "db_datas", // Explicitly set collection name
  }
);

// Create indexes for better query performance
DbDataSchema.index({ job_id: 1, property_id: 1 });
DbDataSchema.index({ created_at: -1 });

// Export the model
export const DbData = mongoose.model<IDbData>("DbData", DbDataSchema);
