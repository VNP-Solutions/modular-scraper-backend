import mongoose, { Document, Schema, Types } from "mongoose";

export type SupportEmailAttachmentFormat = "csv" | "xlsx" | "unknown";

/**
 * Metadata for one CSV / XLSX file Agoda attached to its reply. The parsed rows
 * are deliberately not kept: the untouched original is archived to S3, and rows
 * stored here would be an unindexable second copy that goes stale as soon as
 * the reopen rules change.
 */
export interface ISupportEmailAttachment {
  filename: string;
  mime_type: string;
  size_bytes: number;
  format: SupportEmailAttachmentFormat;
  /** Header names exactly as they appear in the file. */
  columns: string[];
  /** How many rows the file held. The rows themselves live in S3, not here. */
  row_count: number;
  /** Which report layout the reopen rules recognised. */
  sheet_type?: string;
  parse_error?: string;
  /** Archived copy of the original file Agoda sent. */
  s3_url?: string | null;
  s3_key?: string | null;
  /** Why the archive upload failed, when it did. */
  upload_error?: string;
}

/**
 * One Agoda Partner Support email, captured from Gmail and kept so the same
 * message is never processed twice. `message_id` is Gmail's own immutable ID
 * and is the deduplication key.
 */
export interface ISupportEmail extends Document {
  _id: Types.ObjectId;
  message_id: string;
  thread_id?: string | null;
  agoda_id: string;
  /** Job whose run first captured this email. */
  job_id?: Types.ObjectId;
  property_id?: Types.ObjectId;

  from_address: string;
  to_address?: string | null;
  subject?: string | null;
  /** Raw `Date` header as Agoda sent it. */
  date_header?: string | null;
  /** Gmail `internalDate`, i.e. when the message actually arrived. */
  received_at?: Date | null;

  body_text: string;
  case_id?: string | null;
  property_name?: string | null;
  city?: string | null;
  country?: string | null;
  reservation_ids: string[];
  partner_email?: string | null;

  attachments: ISupportEmailAttachment[];

  should_reopen: boolean;
  reopen_booking_ids: string[];
  collect_booking_ids: string[];

  createdAt: Date;
  updatedAt: Date;
}

const SupportEmailAttachmentSchema = new Schema<ISupportEmailAttachment>(
  {
    filename: { type: String, required: true },
    mime_type: { type: String, required: true },
    size_bytes: { type: Number, required: true, default: 0 },
    format: {
      type: String,
      enum: ["csv", "xlsx", "unknown"],
      required: true,
    },
    columns: { type: [String], default: [] },
    row_count: { type: Number, required: true, default: 0 },
    sheet_type: { type: String, required: false },
    parse_error: { type: String, required: false },
    s3_url: { type: String, required: false, default: null },
    s3_key: { type: String, required: false, default: null },
    upload_error: { type: String, required: false },
  },
  { _id: false }
);

const SupportEmailSchema = new Schema<ISupportEmail>(
  {
    message_id: {
      type: String,
      required: true,
      // Sole dedup key; `unique` already builds the index.
      unique: true,
    },
    thread_id: { type: String, required: false },
    agoda_id: { type: String, required: true },
    job_id: { type: Schema.Types.ObjectId, ref: "Job", required: false },
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: false,
    },

    from_address: { type: String, required: true },
    to_address: { type: String, required: false },
    subject: { type: String, required: false },
    date_header: { type: String, required: false },
    received_at: { type: Date, required: false },

    body_text: { type: String, default: "" },
    case_id: { type: String, required: false },
    property_name: { type: String, required: false },
    city: { type: String, required: false },
    country: { type: String, required: false },
    reservation_ids: { type: [String], default: [] },
    partner_email: { type: String, required: false },

    attachments: { type: [SupportEmailAttachmentSchema], default: [] },

    should_reopen: { type: Boolean, default: false },
    reopen_booking_ids: { type: [String], default: [] },
    collect_booking_ids: { type: [String], default: [] },
  },
  {
    timestamps: true,
    collection: "support_emails",
  }
);

SupportEmailSchema.index({ agoda_id: 1, received_at: -1 });
SupportEmailSchema.index({ case_id: 1 });

export const SupportEmail = mongoose.model<ISupportEmail>(
  "SupportEmail",
  SupportEmailSchema
);
