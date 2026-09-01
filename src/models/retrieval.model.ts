import mongoose, { Document, Schema, Types } from "mongoose";
import {
  JobStatus,
  OTAProvider,
  PostingType,
  ScreenshotEntry,
} from "./job.model.js";

/**
 * One hotel's retrieval job inside a parent retrieval. Shaped like a `Job`, but
 * owned by the retrieval backend (Prisma) and shared through the same MongoDB.
 *
 * Two things that will silently break that project if got wrong: the OTA
 * provider is stored as `OTA` rather than `ota_provider`, and every id must be
 * a real `ObjectId` rather than a string.
 */
export interface IRetrieval extends Document {
  _id: Types.ObjectId;
  name?: string;
  job_status: JobStatus;

  portfolio_id?: Types.ObjectId;
  sub_portfolio_id?: Types.ObjectId;
  property_id?: Types.ObjectId;
  user_id: Types.ObjectId;
  batch_id?: Types.ObjectId;
  parent_retrieval_id: Types.ObjectId;

  posting_type: PostingType;
  portfolio_name?: string;
  sub_portfolio_name?: string;
  property_name: string;
  billing_type?: string;
  next_due_date?: Date;
  OTA: OTAProvider;

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
  failed_reason?: string;
  screenshot_urls?: ScreenshotEntry[];
  live_url?: string;
  current_url?: string;
  case_open?: boolean;
  watcher_emails?: string[];
  /** Reservation / booking IDs this retrieval has to collect. */
  reservations: string[];
  is_archived: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const RetrievalSchema = new Schema<IRetrieval>(
  {
    name: { type: String, required: false },
    job_status: {
      type: String,
      enum: Object.values(JobStatus),
      default: JobStatus.Pending,
    },

    portfolio_id: { type: Schema.Types.ObjectId, required: false },
    sub_portfolio_id: { type: Schema.Types.ObjectId, required: false },
    property_id: { type: Schema.Types.ObjectId, required: false },
    user_id: { type: Schema.Types.ObjectId, required: true },
    batch_id: { type: Schema.Types.ObjectId, required: false },
    parent_retrieval_id: { type: Schema.Types.ObjectId, required: true },

    posting_type: {
      type: String,
      enum: Object.values(PostingType),
      required: true,
    },
    portfolio_name: { type: String, required: false },
    sub_portfolio_name: { type: String, required: false },
    property_name: { type: String, required: true },
    billing_type: { type: String, required: false },
    next_due_date: { type: Date, required: false },
    OTA: {
      type: String,
      enum: Object.values(OTAProvider),
      required: true,
    },

    remaining_direct_billed: { type: Number, required: true, default: 0 },
    total_collectable: { type: Number, required: true, default: 0 },
    total_amount_confirmed: { type: Number, required: true, default: 0 },
    execution_type: { type: String, required: true },

    retries_attempted: { type: Number, default: 0 },
    max_retries: { type: Number, default: 3 },
    retry_delay_ms: { type: Number, required: false },
    priority: { type: Number, default: 0 },
    job_backoff_length_loading: { type: Number, required: true },
    job_backoff_length_selector: { type: Number, required: true },

    queue_name: { type: String, required: false },
    worker_assigned: { type: String, required: false },
    batch_execution_id: { type: String, required: false },
    start_date: { type: String, required: false },
    end_date: { type: String, required: false },
    log_link: { type: String, required: false },
    failed_reason: { type: String, required: false },
    screenshot_urls: {
      type: [
        {
          step: { type: String, required: true },
          url: { type: String, required: true },
          timestamp: { type: String, required: true },
          type: { type: String, enum: ["step", "error"], required: true },
        },
      ],
      default: [],
    },
    live_url: { type: String, required: false },
    current_url: { type: String, required: false },
    case_open: { type: Boolean, default: false },
    watcher_emails: { type: [String], default: [] },
    reservations: { type: [String], default: [] },
    is_archived: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    collection: "retrievals",
  },
);

RetrievalSchema.index({ parent_retrieval_id: 1 });
RetrievalSchema.index({ property_id: 1 });

export const Retrieval = mongoose.model<IRetrieval>(
  "Retrieval",
  RetrievalSchema,
);
