/**
 * Shared types for the Agoda Partner Support email scraper.
 */

/** Sender Agoda replies always come from; anything else is ignored. */
export const AGODA_PARTNER_SUPPORT_ADDRESS = "partnersupport@agoda.com";

/** How far back to search Gmail when the caller does not specify a window. */
export const DEFAULT_LOOKBACK_DAYS = 10;

export interface SupportEmailHeaders {
  from: string;
  to: string | null;
  subject: string | null;
  date: string | null;
}

export type AttachmentFormat = "csv" | "xlsx" | "unknown";

/** Which of the two Agoda report layouts an attachment turned out to be. */
export type SheetType =
  /** Type 1 — has `Payment Status`, amount lives in `LP(USD)`. */
  | "payment_status"
  /** Type 2 — has `Booking Matched Status Name`, amount in `USD Total Include GST`. */
  | "booking_matched_status"
  | "unknown";

export type RowAction =
  /** Amount is known and above the minimum; the property can charge it. */
  | "COLLECT"
  /** Amount cannot be determined, so the case has to go back to Agoda. */
  | "REOPEN"
  /** Nothing to do for this row. */
  | "SKIP";

export interface EvaluatedRow {
  bookingId: string;
  action: RowAction;
  /** Parsed USD amount; null when the column is absent or unreadable. */
  amount: number | null;
  reason: string;
  checkoutDate: string | null;
  row: Record<string, string>;
}

export interface ReopenRuleOptions {
  /** Injectable clock, used by tests. */
  now?: Date;
}

export interface ReopenDecision {
  sheetType: SheetType;
  /** True when at least one row came back as REOPEN. */
  shouldReopen: boolean;
  /** Rows the property can charge directly. */
  collect: EvaluatedRow[];
  /** Rows that need the case reopened with Agoda. */
  reopen: EvaluatedRow[];
  /** Rows that need no action, each with the reason it was dropped. */
  skipped: EvaluatedRow[];
  /** Sum of the COLLECT amounts, or null when there are none. */
  totalCollectAmountUsd: number | null;
  /** Which column each rule input was read from, for troubleshooting. */
  detectedColumns: Record<string, string | null>;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  format: AttachmentFormat;
  /** Column names in the order they appear in the file. */
  columns: string[];
  rows: Record<string, string>[];
  rowCount: number;
  /** Set when the file was downloaded but could not be parsed. */
  parseError?: string;
  /** Verdict from the reopen rules; absent for attachments that were skipped. */
  reopenDecision?: ReopenDecision;
}

export interface ParsedSupportEmailBody {
  caseId: string | null;
  propertyId: string | null;
  propertyName: string | null;
  city: string | null;
  country: string | null;
  /** Reservation numbers Agoda listed as still having a pending balance. */
  reservationIds: string[];
  /** The accommodation partner email Agoda echoes back at the end of the reply. */
  partnerEmail: string | null;
  /** Plain-text rendering of the message, useful for debugging a failed parse. */
  text: string;
}

/** Roll-up of the per-attachment decisions for a single email. */
export interface ReopenSummary {
  shouldReopen: boolean;
  reason: string;
  /** Bookings needing the case reopened, deduplicated across attachments. */
  reopenBookingIds: string[];
  /** Bookings the property can charge directly, deduplicated. */
  collectBookingIds: string[];
  totalCollectAmountUsd: number | null;
}

export interface SupportEmail {
  messageId: string;
  threadId: string | null;
  /** Gmail internalDate as an ISO string. */
  receivedAt: string | null;
  headers: SupportEmailHeaders;
  body: ParsedSupportEmailBody;
  attachments: ParsedAttachment[];
  /** Combined reopen verdict across every attachment on this email. */
  reopen: ReopenSummary;
}

export type SupportEmailOutcome =
  /** Latest matching message was from Agoda Partner Support and was parsed. */
  | { status: "parsed"; email: SupportEmail }
  /** Messages matched the Agoda ID but the newest one came from someone else. */
  | { status: "not_from_partner_support"; from: string; receivedAt: string | null }
  /** No message mentioning the Agoda ID within the lookback window. */
  | { status: "no_email_found" };

export interface ScrapeSupportEmailOptions {
  /** Lookback window in days. Defaults to `DEFAULT_LOOKBACK_DAYS`. */
  lookbackDays?: number;
  /** How many Gmail search hits to consider when picking the newest message. */
  maxCandidates?: number;
  /** Skip downloading and parsing CSV/XLSX attachments. */
  includeAttachments?: boolean;
  /** Overrides for the reopen thresholds. */
  reopenRules?: ReopenRuleOptions;
}

/** Per-job result for the bulk endpoint. */
export interface JobSupportEmailResult {
  jobId: string;
  agodaId: string;
  outcome: SupportEmailOutcome;
}

export interface BulkSupportEmailResults {
  processed: JobSupportEmailResult[];
  invalid: Array<{ jobId: string; reason: string; currentStatus?: string }>;
  errors: Array<{ jobId: string; error: string }>;
}
