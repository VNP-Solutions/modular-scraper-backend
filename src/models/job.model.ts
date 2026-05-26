import mongoose, { Document, Schema, Types } from "mongoose";

// Updated Enums based on user requirements
export enum JobStatus {
  Pending = "Pending",
  Running = "Running",
  Completed = "Completed",
  Partial = "Partial",
  Failed = "Failed",
  Stopped = "Stopped",
  Cancelled = "Cancelled",
  InQueue = "InQueue",
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
  next_due_date: Date;
  end_date?: string;
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
  /** Google Drive URL for exported Booking job_items XLSX after Completed */
  job_items_file_link?: string;
  live_url?: string;
  watcher_emails?: string[];
  queue_name?: string;
  worker_assigned?: string;
  batch_execution_id?: string;
  failed_reason?: string;
  /** Ordered list of screenshots taken during job execution, uploaded to S3 */
  screenshot_urls?: {
    step: string;
    url: string;
    timestamp: string;
    type: "step" | "error";
  }[];
  /**
   * Booking VCCS Phase 1: count of reservations after the charge-before / end_date
   * filter (matches log "Total reservations collected").
   */
  booking_vccs_filtered_reservation_count?: number;
  /** True while the scraper is waiting for an OTP code in `otp_codes`. */
  otp_needed?: boolean;
  /** True once the job reaches Completed after a successful OTP verification. */
  otp_fulfilled?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Legacy MongoDB field name for the **provider** (e.g. `"Booking"`). Not the same concept as
 * `posting_type === PostingType.OTA` ("OTA" vs "OTA_PLUS"). Do not read this from app code — use
 * `resolveJobOtaProvider()` or `ota_provider` after `jobService.getJobById()` normalizes the doc.
 */
const LEGACY_OTA_PROVIDER_BSON_KEY = "OTA" as const;

/**
 * Effective OTA provider: `ota_provider`, else legacy BSON key `OTA` (see module constant).
 */
export function resolveJobOtaProvider(job: unknown): unknown {
  if (!job || typeof job !== "object") return undefined;
  const o = job as Record<string, unknown>;
  const p = o.ota_provider;
  if (p !== null && p !== undefined && String(p).trim() !== "") {
    return p;
  }
  const legacy = o[LEGACY_OTA_PROVIDER_BSON_KEY];
  if (legacy !== null && legacy !== undefined && String(legacy).trim() !== "") {
    return legacy;
  }
  return undefined;
}

/** @internal Schema only: maps legacy BSON `OTA` without putting `OTA` on public {@link IJob}. */
type IJobWithLegacyOtaBson = IJob & {
  OTA?: OTAProvider | string;
};

// Mongoose Schema (read-only, updates only)
const JobSchema = new Schema<IJobWithLegacyOtaBson>(
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
    next_due_date: {
      type: Date,
      required: true,
    },
    end_date: {
      type: String,
      required: false,
    },
    OTA: {
      type: String,
      enum: Object.values(OTAProvider),
      required: false,
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
    job_items_file_link: {
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
    failed_reason: {
      type: String,
      required: false,
    },
    screenshot_urls: {
      type: [
        {
          step: { type: String, required: true },
          url: { type: String, required: true },
          timestamp: { type: String, required: true },
          type: { type: String, enum: ["step", "error"], required: true },
        },
      ],
      required: false,
      default: [],
    },
    booking_vccs_filtered_reservation_count: {
      type: Number,
      required: false,
    },
    otp_needed: {
      type: Boolean,
      required: false,
      default: false,
    },
    otp_fulfilled: {
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

/** Typed as `IJob` so callers never see ambiguous `OTA`; legacy BSON is still loaded at runtime. */
export const Job = mongoose.model<IJobWithLegacyOtaBson>(
  "Job",
  JobSchema
) as mongoose.Model<IJob>;
