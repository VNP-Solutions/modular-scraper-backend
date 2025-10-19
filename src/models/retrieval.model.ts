import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for the Retrieval document
export interface IRetrieval extends Document {
  _id: Types.ObjectId;
  name?: string;
  job_status: string;
  portfolio_id?: Types.ObjectId;
  sub_portfolio_id?: Types.ObjectId;
  property_id?: Types.ObjectId;
  user_id: Types.ObjectId;
  batch_id?: Types.ObjectId;
  parent_retrieval_id: Types.ObjectId;
  posting_type: string;
  portfolio_name?: string;
  sub_portfolio_name?: string;
  property_name: string;
  billing_type?: string;
  next_due_date?: Date;
  ota_provider: string;
  remaining_direct_billed: number;
  total_collectable: number;
  total_amount_confirmed: number;
  execution_type: string;
  retries_attempted: number;
  max_retries: number;
  retry_delay_ms?: number;
  priority: number;
  job_backoff_length_loading: number;
  job_backoff_length_selector: number;
  queue_name?: string;
  worker_assigned?: string;
  batch_execution_id?: string;
  start_date?: string;
  end_date?: string;
  log_link?: string;
  live_url?: string;
  current_url?: string;
  case_open?: boolean;
  watcher_emails: string[];
  reservations: string[]; // Array of reservation IDs
  createdAt: Date;
  updatedAt: Date;
}

// Mongoose Schema
const RetrievalSchema = new Schema<IRetrieval>(
  {
    name: {
      type: String,
      required: false,
    },
    job_status: {
      type: String,
      default: "Pending",
      required: true,
    },
    portfolio_id: {
      type: Schema.Types.ObjectId,
      ref: "Portfolio",
      required: false,
    },
    sub_portfolio_id: {
      type: Schema.Types.ObjectId,
      ref: "SubPortfolio",
      required: false,
    },
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: false,
    },
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    batch_id: {
      type: Schema.Types.ObjectId,
      required: false,
    },
    parent_retrieval_id: {
      type: Schema.Types.ObjectId,
      ref: "ParentRetrieval",
      required: true,
    },
    posting_type: {
      type: String,
      required: true,
    },
    portfolio_name: {
      type: String,
      required: false,
    },
    sub_portfolio_name: {
      type: String,
      required: false,
    },
    property_name: {
      type: String,
      required: true,
    },
    billing_type: {
      type: String,
      required: false,
    },
    next_due_date: {
      type: Date,
      required: false,
    },
    ota_provider: {
      type: String,
      required: true,
    },
    remaining_direct_billed: {
      type: Number,
      required: true,
      default: 0,
    },
    total_collectable: {
      type: Number,
      required: true,
      default: 0,
    },
    total_amount_confirmed: {
      type: Number,
      required: true,
      default: 0,
    },
    execution_type: {
      type: String,
      required: true,
    },
    retries_attempted: {
      type: Number,
      default: 0,
      required: true,
    },
    max_retries: {
      type: Number,
      default: 3,
      required: true,
    },
    retry_delay_ms: {
      type: Number,
      required: false,
    },
    priority: {
      type: Number,
      default: 0,
      required: true,
    },
    job_backoff_length_loading: {
      type: Number,
      required: true,
    },
    job_backoff_length_selector: {
      type: Number,
      required: true,
    },
    queue_name: {
      type: String,
      required: false,
    },
    worker_assigned: {
      type: String,
      required: false,
    },
    batch_execution_id: {
      type: String,
      required: false,
    },
    start_date: {
      type: String,
      required: false,
    },
    end_date: {
      type: String,
      required: false,
    },
    log_link: {
      type: String,
      required: false,
    },
    live_url: {
      type: String,
      required: false,
    },
    current_url: {
      type: String,
      required: false,
    },
    case_open: {
      type: Boolean,
      required: false,
      default: false,
    },
    watcher_emails: {
      type: [String],
      required: true,
      default: [],
    },
    reservations: {
      type: [String],
      required: true,
      default: [],
    },
  },
  {
    timestamps: true,
    collection: "retrievals",
  }
);

// Indexes
RetrievalSchema.index({ _id: 1, job_status: 1 });
RetrievalSchema.index({ user_id: 1, job_status: 1 });
RetrievalSchema.index({ property_id: 1, job_status: 1 });
RetrievalSchema.index({ parent_retrieval_id: 1 });

export const Retrieval = mongoose.model<IRetrieval>(
  "Retrieval",
  RetrievalSchema
);
