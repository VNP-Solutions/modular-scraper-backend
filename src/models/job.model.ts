import mongoose, { Document, Schema, Types } from "mongoose";

// Updated Enums based on user requirements
export enum JobStatus {
  Pending = "Pending",
  Running = "Running",
  Completed = "Completed",
  Partial = "Partial",
  Failed = "Failed",
  Stopped = "Stopped",
  InQueue = "InQueue",
}

/**
 * Progress and outcome of the Agoda "reopen case" flow. Tracked separately from
 * `job_status` so reopening a case never rewrites the result of the
 * property run that produced it.
 */
export enum CaseStatus {
  /** No reopen has been attempted yet — the state every new job starts in. */
  Pending = "Pending",
  /** Accepted by the worker pool, waiting on a free worker or the OTP. */
  CaseInQueue = "CaseInQueue",
  /** A worker has picked it up and the browser run is under way. */
  CaseRunning = "CaseRunning",
  /** Need Help request was filed successfully; the case is open with Agoda. */
  CaseReopen = "CaseReopen",
  /** The reopen run could not complete. */
  ParserCaseReopeningFailed = "ParserCaseReopeningFailed",
  /** Nothing outstanding on the case. */
  CaseClose = "CaseClose",
}

/**
 * Where the job stands with Agoda Partner Support, judged from the newest reply
 * to land after the property run. Set by `/api/agoda/support-email-run-job`.
 */
export enum ReplyStatus {
  /** Nothing back from Agoda yet. Past `reply_deadline_at` it is overdue. */
  NoReplied = "NoReplied",
  /** Agoda replied and at least one booking needs the case reopened. */
  RepliedRed = "RepliedRed",
  /** Agoda replied and nothing needs reopening — the balance is collectable. */
  RepliedGreen = "RepliedGreen",
}

/** Grace period Agoda gets to reply before a job counts as unanswered. */
export const REPLY_DEADLINE_HOURS = 48;

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
  /** Google Drive URL for exported Agoda job_items XLSX after Completed/Partial */
  job_items_file_link?: string;
  /**
   * S3 URL of the CSV attached during Agoda Need Help. Written only when
   * `job_status` becomes Completed — never for Partial, Failed, or in-flight runs.
   */
  need_help_file_url?: string | null;
  live_url?: string;
  watcher_emails?: string[];
  case_open?: boolean;
  case_status?: CaseStatus;
  reply_status?: ReplyStatus;
  /**
   * When Agoda's reply stops being merely absent and starts being late — the
   * property run's completion plus `REPLY_DEADLINE_HOURS`. Rewritten every time
   * the job completes, so a rerun restarts the clock.
   */
  reply_deadline_at?: Date | null;
  queue_name?: string;
  worker_assigned?: string;
  batch_execution_id?: string;
  start_date?: string;
  end_date?: string;
  failed_reason?: string;
  /** Why the reopen-case run failed. The `case_status` counterpart of `failed_reason`. */
  case_failed_reason?: string | null;
  /** Ordered list of screenshots taken during job execution, uploaded to S3 */
  screenshot_urls?: ScreenshotEntry[];
  /**
   * Screenshots from the Agoda reopen-case run. Kept apart from
   * `screenshot_urls` so a reopen never overwrites the property run's trail;
   * replaced wholesale each time a reopen starts.
   */
  case_opening_screenshot?: ScreenshotEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ScreenshotEntry {
  step: string;
  url: string;
  timestamp: string;
  type: "step" | "error";
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
    job_items_file_link: {
      type: String,
      required: false,
    },
    need_help_file_url: {
      type: String,
      required: false,
      default: null,
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
    case_status: {
      type: String,
      enum: Object.values(CaseStatus),
      required: false,
      default: CaseStatus.Pending,
    },
    reply_status: {
      type: String,
      enum: Object.values(ReplyStatus),
      required: false,
      default: ReplyStatus.NoReplied,
    },
    reply_deadline_at: {
      type: Date,
      required: false,
      default: null,
    },
    start_date: {
      type: String,
      required: false,
    },
    end_date: {
      type: String,
      required: false,
    },
    failed_reason: {
      type: String,
      required: false,
    },
    case_failed_reason: {
      type: String,
      required: false,
      default: null,
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
    case_opening_screenshot: {
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
