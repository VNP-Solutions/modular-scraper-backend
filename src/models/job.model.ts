import mongoose, { Document, Schema, Types } from "mongoose";

// Updated Enums based on user requirements
export enum JobStatus {
  Pending = "Pending",
  Running = "Running",
  Completed = "Completed",
  Partial = "Partial",
  Failed = "Failed",
  Stopped = "Stopped",
}

export enum PostingType {
  OTA = "OTA",
  OTA_PLUS = "OTA_PLUS",
}

export enum OTAProvider {
  Expedia = "Expedia",
  Booking = "Booking",
  Agoda = "Agoda",
}

export enum InvitationStatus {
  Pending = "Pending",
  Accepted = "Accepted",
  Expired = "Expired",
  Cancelled = "Cancelled",
}

// Interface for the Job document (simplified for updates only)
export interface IJob extends Document {
  _id: Types.ObjectId;
  name?: string;
  job_status: JobStatus;
  portfolio_id?: Types.ObjectId;
  sub_portfolio_id?: Types.ObjectId;
  property_id?: Types.ObjectId;
  user_id: Types.ObjectId;
  posting_type: PostingType;
  portfolio_name: string;
  sub_portfolio_name: string;
  property_name: string;
  billing_type: string;
  db_billing_duration?: number;
  next_due_date: Date;
  ota_provider: OTAProvider;
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
  log_link?: string;
  live_url?: string;
  watcher_emails?: string[];
  case_open?: boolean;
  queue_name?: string;
  worker_assigned?: string;
  batch_execution_id?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Mongoose Schema (read-only, updates only)
const JobSchema = new Schema<IJob>(
  {
    name: {
      type: String,
      required: false,
    },
    job_status: {
      type: String,
      enum: Object.values(JobStatus),
      default: JobStatus.Pending,
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
    posting_type: {
      type: String,
      enum: Object.values(PostingType),
      required: true,
    },
    portfolio_name: {
      type: String,
      required: true,
    },
    sub_portfolio_name: {
      type: String,
      required: true,
    },
    property_name: {
      type: String,
      required: true,
    },
    billing_type: {
      type: String,
      required: true,
    },
    db_billing_duration: {
      type: Number,
      required: false,
    },
    next_due_date: {
      type: Date,
      required: true,
    },
    ota_provider: {
      type: String,
      enum: Object.values(OTAProvider),
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
    log_link: {
      type: String,
      required: false,
    },
    live_url: {
      type: String,
      required: false,
    },
    watcher_emails: {
      type: [String],
      required: false,
      default: [],
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
    case_open: {
      type: Boolean,
      required: false,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: "jobs",
  }
);

// Indexes for job status updates and queries
JobSchema.index({ _id: 1, job_status: 1 });
JobSchema.index({ user_id: 1, job_status: 1 });
JobSchema.index({ property_id: 1, job_status: 1 });

export const Job = mongoose.model<IJob>("Job", JobSchema);
