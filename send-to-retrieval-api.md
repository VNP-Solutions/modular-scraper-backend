# `POST /api/agoda/send-to-retrieval` — Complete Port Guide

Everything needed to rebuild this endpoint in another project that shares the
same MongoDB. Source is given verbatim where it must match exactly, and as a
contract where you should adapt it to the host project's conventions.

Stack assumed: **Node 18+, TypeScript (ESM), Express 5, Mongoose 8**.

> **This endpoint depends on `POST /api/agoda/support-email-run-job` having run
> first.** That call is what captures Agoda's reply into `support_emails`; this
> one only reads it. If you have not ported that endpoint too, see
> `support-email-run-job-api.md`. With no stored reply, every job here is
> skipped.

---

## 1. What the endpoint does

Given a list of job IDs, for each one:

1. Reject the job unless `job_status === "Completed"`.
2. Resolve the property's `agoda_id` from the job's `property_id`.
3. Look up the newest **stored** Agoda Partner Support reply for that Agoda ID
   in `support_emails`, requiring it to have arrived after the property run
   finished.
4. Skip the job if that reply still flags any booking as needing a reopen.
5. Skip the job if the reply has no collectable bookings.
6. Otherwise collect it as a candidate.

Then, once across the whole request:

7. Write **one** `parent_retrievals` document covering the entire call.
8. Write **one** `retrievals` document per candidate property beneath it, with
   the collectable booking IDs in `reservations[]`.
9. Set `case_status` to `CaseClose` on every job whose retrieval was written.

**No Gmail, no S3, no browser, no worker pool.** This is a pure database
endpoint and responds once the writes are done.

### Why it reads the database instead of Gmail

An earlier version re-scraped Gmail here. Reading the stored record instead
means this endpoint and the capture endpoint always act on the same reply, and
removes a second Gmail round-trip per job. It also means the Google OAuth
setup, the attachment parser and the S3 archive are **not** needed in the host
project unless it is also porting the capture endpoint.

---

## 2. Dependencies

```bash
npm install express mongoose
npm install -D typescript @types/express @types/node
```

That is the whole list. If the host project already has Express and Mongoose,
nothing new is required.

---

## 3. Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URI` | MongoDB connection string — must be the **same database** as the scraper and the retrieval backend |

No AWS, Google or scraper credentials are used by this endpoint.

---

## 4. Collections touched

| Collection | Access | Notes |
| --- | --- | --- |
| `jobs` | read + write | Reads `job_status`, `property_id`, `reply_deadline_at`, and the fields copied onto the retrieval; writes `case_status` |
| `properties` | read | Reads `agoda_id` |
| `support_emails` | read | Populated by `POST /api/agoda/support-email-run-job` |
| `parent_retrievals` | write | One document per API call |
| `retrievals` | write | One document per property |

`parent_retrievals` and `retrievals` are **owned by the retrieval backend**
(a Prisma project) and shared through the same MongoDB. The schemas in §6.1 and
§6.2 mirror that project's mapping; see the gotchas in §10 before changing any
field name.

---

## 5. File layout to create

```
src/
  models/
    parent-retrieval.model.ts     (§6.1  — verbatim)
    retrieval.model.ts            (§6.2  — verbatim)
    support-email.model.ts        (§6.3  — verbatim, read-only here)
    job.model.ts                  (§6.4  — enums + fields the host model needs)
    property.model.ts             (§6.5  — contract only)
  services/
    retrieval.service.ts          (§7.1  — verbatim)
    support-email.service.ts      (§7.2  — one lookup method)
    job.service.ts                (§7.3  — three methods)
  common/
    log-helper.ts                 (§7.4  — minimal version)
  app.ts                          (§8    — route handler)
```

> If you already applied `support-email-run-job-api.md` in this project, you
> have `support-email.model.ts`, `support-email.service.ts`, `log-helper.ts` and
> the job model changes. **Do not duplicate them** — just add the one lookup
> method from §7.2.

---

## 6. Models

### 6.1 `src/models/parent-retrieval.model.ts` — verbatim

```ts
import mongoose, { Document, Schema, Types } from "mongoose";
import { OTAProvider } from "./job.model.js";

/**
 * Batch container for retrievals, owned by the retrieval backend (Prisma) and
 * shared through the same MongoDB. Field names follow that project's mapping:
 * the OTA provider is stored as `OTA`, not `ota_provider`.
 */
export interface IParentRetrieval extends Document {
  _id: Types.ObjectId;
  name: string;
  OTA?: OTAProvider;
  is_archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ParentRetrievalSchema = new Schema<IParentRetrieval>(
  {
    name: { type: String, required: true },
    OTA: {
      type: String,
      enum: Object.values(OTAProvider),
      required: false,
    },
    is_archived: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    collection: "parent_retrievals",
  },
);

export const ParentRetrieval = mongoose.model<IParentRetrieval>(
  "ParentRetrieval",
  ParentRetrievalSchema,
);
```

### 6.2 `src/models/retrieval.model.ts` — verbatim

```ts
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
```

### 6.3 `src/models/support-email.model.ts` — verbatim, read-only here

This endpoint only reads four fields (`should_reopen`, `reopen_booking_ids`,
`collect_booking_ids`, plus `received_at` / `direction` / `from_address` for the
lookup), but the model must still match the writer exactly or Mongoose will
misread documents the other project wrote.

```ts
import mongoose, { Document, Schema, Types } from "mongoose";

export type SupportEmailAttachmentFormat = "csv" | "xlsx" | "unknown";

export type SupportEmailDirection = "incoming" | "outgoing";

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
 * One message from the labelled Agoda conversation — Agoda's replies and our
 * own submissions alike — captured from Gmail and kept so the same message is
 * never processed twice. `message_id` is Gmail's own immutable ID and is the
 * deduplication key. Only the newest incoming reply drives the reopen rules;
 * the rest are stored purely as a record of the exchange.
 */
export interface ISupportEmail extends Document {
  _id: Types.ObjectId;
  message_id: string;
  thread_id?: string | null;
  /** `outgoing` when Gmail marked the message as sent by us. */
  direction: SupportEmailDirection;
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
    direction: {
      type: String,
      enum: ["incoming", "outgoing"],
      required: true,
      default: "incoming",
    },
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
```

### 6.4 `src/models/job.model.ts` — enums and fields needed

The host project already has a `jobs` model. **Add** what is missing; do not
recreate the whole schema.

The retrieval models import four things from here, so these must be exported:

```ts
export enum JobStatus {
  Pending = "Pending",
  Running = "Running",
  Completed = "Completed",
  Partial = "Partial",
  Failed = "Failed",
  Stopped = "Stopped",
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

export interface ScreenshotEntry {
  step: string;
  url: string;
  timestamp: string;
  type: "step" | "error";
}
```

This endpoint writes `case_status`, so the enum and field are required:

```ts
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
```

Interface additions:

```ts
  case_status?: CaseStatus;
  /** Why the reopen-case run failed. The `case_status` counterpart of `failed_reason`. */
  case_failed_reason?: string | null;
  /**
   * When Agoda's reply stops being merely absent and starts being late — the
   * property run's completion plus `REPLY_DEADLINE_HOURS`. Rewritten every time
   * the job completes, so a rerun restarts the clock.
   */
  reply_deadline_at?: Date | null;
```

Schema additions:

```ts
    case_status: {
      type: String,
      enum: Object.values(CaseStatus),
      required: false,
      default: CaseStatus.Pending,
    },
    case_failed_reason: {
      type: String,
      required: false,
      default: null,
    },
    reply_deadline_at: {
      type: Date,
      required: false,
      default: null,
    },
```

And the constant the cutoff is derived from:

```ts
/** Grace period Agoda gets to reply before a job counts as unanswered. */
export const REPLY_DEADLINE_HOURS = 48;
```

The endpoint also reads these existing fields and copies most of them onto the
retrieval: `property_name`, `portfolio_id`, `sub_portfolio_id`, `property_id`,
`user_id`, `posting_type`, `portfolio_name`, `sub_portfolio_name`.

> **`reply_deadline_at` is written by the property run**, not by this endpoint.
> If the property run lives only in the original scraper project, nothing here
> writes it — this endpoint just reads it.

### 6.5 `src/models/property.model.ts` — contract only

Only one field is read. The collection is `properties`, and the field is a
**string**, not a number:

```ts
  agoda_id?: string;   // e.g. "2462187"; "0" is treated as unset
```

---

## 7. Services

### 7.1 `src/services/retrieval.service.ts` — verbatim

```ts
/**
 * Creates retrievals for bookings the Agoda report says the property can charge
 * itself.
 *
 * When a captured Partner Support reply leaves nothing to reopen, whatever came
 * back as COLLECT is handed to the retrieval backend as work: one parent per
 * API call, one retrieval per property underneath it. Both collections are
 * owned by that project and shared through the same MongoDB, so the field
 * names and the `ObjectId` types have to match what its Prisma client expects.
 */

import { Types } from "mongoose";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import {
  IJob,
  JobStatus,
  OTAProvider,
  PostingType,
} from "../models/job.model.js";
import { ParentRetrieval } from "../models/parent-retrieval.model.js";
import { IRetrieval, Retrieval } from "../models/retrieval.model.js";

/** Defaults the retrieval importer hard-codes; mirrored so rows look native. */
const EXECUTION_TYPE = "retrieval";
const BACKOFF_LENGTH_LOADING = 5000;
const BACKOFF_LENGTH_SELECTOR = 3000;

export interface CollectRetrievalInput {
  job: IJob;
  agodaId: string;
  /** Booking IDs the reopen rules marked COLLECT. */
  reservations: string[];
}

export interface CreatedRetrieval {
  jobId: string;
  agodaId: string;
  retrievalId: string;
  reservationCount: number;
}

export interface CollectRetrievalResult {
  parentRetrievalId: string | null;
  parentRetrievalName: string | null;
  created: CreatedRetrieval[];
  failed: Array<{ jobId: string; error: string }>;
}

function defaultParentName(now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return `Agoda Collect ${stamp} UTC`;
}

export class RetrievalService {
  /**
   * Writes one parent retrieval and a retrieval per property beneath it.
   *
   * A property whose insert fails is reported and skipped rather than taking
   * the batch down with it, matching how the bulk endpoints behave elsewhere.
   */
  async createCollectRetrievals(
    inputs: CollectRetrievalInput[],
    options: { parentName?: string } = {},
  ): Promise<CollectRetrievalResult> {
    const result: CollectRetrievalResult = {
      parentRetrievalId: null,
      parentRetrievalName: null,
      created: [],
      failed: [],
    };

    const eligible = inputs.filter((input) => input.reservations.length > 0);
    if (eligible.length === 0) return result;

    const parentName = options.parentName ?? defaultParentName(new Date());

    const parent = await ParentRetrieval.create({
      name: parentName,
      OTA: OTAProvider.Agoda,
      is_archived: false,
    });

    result.parentRetrievalId = String(parent._id);
    result.parentRetrievalName = parentName;

    await dualLogInfo(`📦 Created parent retrieval "${parentName}"`, {
      parentRetrievalId: String(parent._id),
      propertyCount: eligible.length,
    });

    for (const input of eligible) {
      const jobId = String(input.job._id);

      try {
        const retrieval = await this.createRetrievalForJob(input, parent._id);

        result.created.push({
          jobId,
          agodaId: input.agodaId,
          retrievalId: String(retrieval._id),
          reservationCount: input.reservations.length,
        });

        await dualLogInfo(
          `🧾 Created retrieval for Agoda ID ${input.agodaId} with ${input.reservations.length} reservation(s)`,
          {
            jobId,
            retrievalId: String(retrieval._id),
            parentRetrievalId: String(parent._id),
          },
        );
      } catch (error: any) {
        await dualLogError(
          `Failed to create retrieval for job ${jobId}:`,
          error,
        );
        result.failed.push({
          jobId,
          error: error?.message || String(error),
        });
      }
    }

    return result;
  }

  private async createRetrievalForJob(
    input: CollectRetrievalInput,
    parentRetrievalId: Types.ObjectId,
  ): Promise<IRetrieval> {
    const { job, reservations } = input;

    return await Retrieval.create({
      name: job.property_name,
      job_status: JobStatus.Pending,

      portfolio_id: job.portfolio_id,
      sub_portfolio_id: job.sub_portfolio_id,
      property_id: job.property_id,
      user_id: job.user_id,
      parent_retrieval_id: parentRetrievalId,

      posting_type: job.posting_type ?? PostingType.OTA,
      portfolio_name: job.portfolio_name,
      sub_portfolio_name: job.sub_portfolio_name,
      property_name: job.property_name,
      OTA: OTAProvider.Agoda,

      // The retrieval run works these out for itself; the importer seeds zeros
      // here too rather than guessing from the report.
      remaining_direct_billed: 0,
      total_collectable: 0,
      total_amount_confirmed: 0,
      execution_type: EXECUTION_TYPE,

      retries_attempted: 0,
      max_retries: 3,
      priority: 0,
      job_backoff_length_loading: BACKOFF_LENGTH_LOADING,
      job_backoff_length_selector: BACKOFF_LENGTH_SELECTOR,

      reservations,
      case_open: false,
      is_archived: false,
    });
  }
}

export const retrievalService = new RetrievalService();
```

### 7.2 `src/services/support-email.service.ts` — the lookup

The only method this endpoint needs. If the capture endpoint is also ported,
add this to the existing service class rather than creating a second one.

```ts
import { type FilterQuery } from "mongoose";
import {
  ISupportEmail,
  SupportEmail,
} from "../models/support-email.model.js";

/** Sender Agoda replies always come from; anything else is ignored. */
export const AGODA_PARTNER_SUPPORT_ADDRESS = "partnersupport@agoda.com";

/**
 * The `from_address` on record is the raw header, e.g.
 * `Agoda <PartnerSupport@agoda.com>`, so the sender is matched inside it.
 */
const PARTNER_SUPPORT_FROM = new RegExp(
  AGODA_PARTNER_SUPPORT_ADDRESS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "i"
);

export class SupportEmailService {
  /**
   * Newest Agoda reply already on record for a property.
   *
   * Reads what an earlier `/api/agoda/support-email-run-job` captured instead of
   * going back to Gmail, so downstream callers act on the stored record rather
   * than re-fetching and risking a different answer.
   *
   * Only inbound Partner Support mail counts: our own submissions carry the same
   * label and would otherwise win on recency.
   */
  async findLatestPartnerSupportReply(
    agodaId: string,
    options: { since?: Date | null } = {}
  ): Promise<ISupportEmail | null> {
    const filter: FilterQuery<ISupportEmail> = {
      agoda_id: agodaId,
      direction: "incoming",
      from_address: PARTNER_SUPPORT_FROM,
    };

    // Served by the { agoda_id, received_at } index.
    if (options.since) {
      filter.received_at = { $gt: options.since };
    }

    return await SupportEmail.findOne(filter)
      .sort({ received_at: -1 })
      .lean<ISupportEmail>()
      .exec();
  }
}

export const supportEmailService = new SupportEmailService();
```

### 7.3 `src/services/job.service.ts` — three methods

**a) `getJobById`** — must return the full document, since the retrieval copies
many fields off it:

```ts
async getJobById(jobId: string): Promise<IJob | null> {
  try {
    const objectId = this.validateObjectId(jobId, "jobId");
    return await Job.findById(objectId);
  } catch (error) {
    console.error(`Error getting job by ID: ${error}`);
    return null;
  }
}

private validateObjectId(id: string, fieldName: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error(
      `Invalid ${fieldName}: ${id}. Must be a valid MongoDB ObjectId (24 character hex string).`
    );
  }
  return new Types.ObjectId(id);
}
```

**b) `getAgodaIdFromJob`** — resolves the property's Agoda ID:

```ts
async getAgodaIdFromJob(jobId: string): Promise<{ agodaId: string } | null> {
  try {
    const job = await Job.findById(new Types.ObjectId(jobId));
    if (!job?.property_id) return null;

    const property = await Property.findById(job.property_id);
    if (!property?.agoda_id || property.agoda_id === "0") return null;

    return { agodaId: property.agoda_id };
  } catch (error) {
    console.error(`Error getting agoda_id for job ${jobId}:`, error);
    return null;
  }
}
```

**c) `updateJobCaseStatus`** — writes `case_status`, and clears
`case_failed_reason` on any status other than the failure one:

```ts
async updateJobCaseStatus(
  jobId: string,
  caseStatus: CaseStatus,
  caseFailedReason?: string | null
): Promise<IJob | null> {
  try {
    const objectId = this.validateObjectId(jobId, "jobId");

    const updateData: Record<string, unknown> = {
      case_status: caseStatus,
      updatedAt: new Date(),
    };

    if (caseStatus === CaseStatus.ParserCaseReopeningFailed) {
      if (caseFailedReason !== undefined) {
        updateData.case_failed_reason = caseFailedReason;
      }
    } else {
      updateData.case_failed_reason = null;
    }

    const updatedJob = await Job.findByIdAndUpdate(objectId, updateData, {
      new: true,
    }).exec();

    if (!updatedJob) {
      console.error(`Job not found: ${jobId}`);
      return null;
    }

    console.log(`✅ Updated case_status to ${caseStatus} for job: ${jobId}`);
    return updatedJob;
  } catch (error) {
    console.error(`Error updating case_status for job ${jobId}:`, error);
    return null;
  }
}
```

### 7.4 `src/common/log-helper.ts` — minimal version

Only two exports are used, by the retrieval service. Map onto the host
project's logger if it has one.

```ts
export async function dualLogInfo(message: string, metadata?: any): Promise<void> {
  console.log(message, metadata ? JSON.stringify(metadata) : "");
}

export async function dualLogError(
  message: string,
  error?: any,
  metadata?: any
): Promise<void> {
  console.error(
    message,
    error instanceof Error ? error.message : error,
    metadata ? JSON.stringify(metadata) : ""
  );
}
```

---

## 8. The route handler

```ts
import express from "express";
import {
  CaseStatus,
  JobStatus,
  REPLY_DEADLINE_HOURS,
} from "../models/job.model.js";
import { jobService } from "../services/job.service.js";
import {
  retrievalService,
  type CollectRetrievalInput,
} from "../services/retrieval.service.js";
import { supportEmailService } from "../services/support-email.service.js";

app.post("/api/agoda/send-to-retrieval", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { job_ids } = req.body;

    if (!job_ids || !Array.isArray(job_ids) || job_ids.length === 0) {
      return res.status(400).json({
        status: 400,
        message: "job_ids array is required and must not be empty",
      });
    }

    const results: {
      skipped: Array<{ jobId: string; agodaId?: string; reason: string }>;
      invalid: Array<{ jobId: string; reason: string; currentStatus?: string }>;
      errors: Array<{ jobId: string; error: string }>;
    } = { skipped: [], invalid: [], errors: [] };

    // Gathered across the loop so the whole call shares one parent retrieval.
    const collectCandidates: CollectRetrievalInput[] = [];

    for (const jobId of job_ids) {
      try {
        const job = await jobService.getJobById(jobId);
        if (!job) {
          results.invalid.push({ jobId, reason: "Job not found" });
          continue;
        }

        if (job.job_status !== JobStatus.Completed) {
          results.invalid.push({
            jobId,
            reason: `Job ${jobId} is ${job.job_status}; only Completed jobs can be sent to retrieval.`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const propertyData = await jobService.getAgodaIdFromJob(jobId);
        if (!propertyData?.agodaId) {
          results.invalid.push({
            jobId,
            reason: `Cannot retrieve a valid agoda_id for job ${jobId}. The property may not have agoda_id assigned or it is "0".`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const { agodaId } = propertyData;

        // `updatedAt` is no use as the cutoff here: capturing the email writes
        // reply_status back to the job and pushes it past the email's arrival.
        // The completion time behind reply_deadline_at is not moved by those
        // writes, so it still marks the run this reply has to be answering.
        const runCompletedAt = job.reply_deadline_at
          ? new Date(
              job.reply_deadline_at.getTime() -
                REPLY_DEADLINE_HOURS * 60 * 60 * 1000
            )
          : null;

        const email = await supportEmailService.findLatestPartnerSupportReply(
          agodaId,
          { since: runCompletedAt }
        );

        if (!email) {
          results.skipped.push({
            jobId,
            agodaId,
            reason: runCompletedAt
              ? `No stored Agoda reply that arrived after the run finished (${runCompletedAt.toISOString()}). Capture it with POST /api/agoda/support-email-run-job first.`
              : "No stored Agoda reply for this property. Capture it with POST /api/agoda/support-email-run-job first.",
          });
          continue;
        }

        // The case has to be settled with Agoda before the balance can be
        // treated as collectable, so anything still needing a reopen waits.
        if (email.should_reopen && email.reopen_booking_ids.length > 0) {
          results.skipped.push({
            jobId,
            agodaId,
            reason: `${email.reopen_booking_ids.length} booking(s) still need the case reopened`,
          });
          continue;
        }

        if (email.collect_booking_ids.length === 0) {
          results.skipped.push({
            jobId,
            agodaId,
            reason: "No collectable booking in the stored reply",
          });
          continue;
        }

        collectCandidates.push({
          job,
          agodaId,
          reservations: email.collect_booking_ids,
        });
      } catch (error: any) {
        console.error(`Error preparing retrieval for job ${jobId}:`, error);
        results.errors.push({
          jobId,
          error: error?.message || String(error),
        });
      }
    }

    const retrieval = await retrievalService.createCollectRetrievals(
      collectCandidates
    );

    // Handing the balance to the retrieval side leaves nothing waiting on
    // Agoda, so the case is done. Jobs whose retrieval failed keep their
    // current case_status so the next call can pick them up again.
    for (const created of retrieval.created) {
      try {
        await jobService.updateJobCaseStatus(
          created.jobId,
          CaseStatus.CaseClose
        );
      } catch (error) {
        console.error(
          `Error setting case_status to CaseClose for job ${created.jobId}:`,
          error
        );
      }
    }

    const bookingsSent = retrieval.created.reduce(
      (sum, entry) => sum + entry.reservationCount,
      0
    );

    return res.status(200).json({
      status: 200,
      message: `Processed ${job_ids.length} jobs. ${retrieval.created.length} retrieval(s) created covering ${bookingsSent} booking(s), ${results.skipped.length} skipped, ${results.invalid.length} invalid, ${results.errors.length} with errors.`,
      results: { ...results, retrieval },
    });
  } catch (err: any) {
    console.error("Error in /api/agoda/send-to-retrieval:", err);
    res.status(500).json({
      status: 500,
      message: "Error sending Agoda bookings to retrieval",
      error: err.message,
    });
  }
}) as any);
```

---

## 9. Request and response

### Request

```json
{ "job_ids": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"] }
```

### Response (200)

```json
{
  "status": 200,
  "message": "Processed 2 jobs. 1 retrieval(s) created covering 3 booking(s), 1 skipped, 0 invalid, 0 with errors.",
  "results": {
    "skipped": [
      {
        "jobId": "507f1f77bcf86cd799439012",
        "agodaId": "98433",
        "reason": "2 booking(s) still need the case reopened"
      }
    ],
    "invalid": [],
    "errors": [],
    "retrieval": {
      "parentRetrievalId": "66f1a2b3c4d5e6f7a8b9c0d1",
      "parentRetrievalName": "Agoda Collect 2026-09-01 06:12 UTC",
      "created": [
        {
          "jobId": "507f1f77bcf86cd799439011",
          "agodaId": "2462187",
          "retrievalId": "66f1a2b3c4d5e6f7a8b9c0d2",
          "reservationCount": 3
        }
      ],
      "failed": []
    }
  }
}
```

`parentRetrievalId` and `parentRetrievalName` are `null` when no job had
collectable bookings — no empty parent is written.

### Reasons a job lands in each bucket

| Bucket | Cause |
| --- | --- |
| `invalid` | Job not found, `job_status` is not `Completed`, or the property has no usable `agoda_id` |
| `skipped` | No stored reply after the run, the reply still needs a reopen, or it has no collectable bookings |
| `errors` | An exception while preparing that job; the rest of the batch continues |
| `retrieval.failed` | Candidate was valid but its `retrievals` insert failed; `case_status` is left alone so a retry can pick it up |

---

## 10. Gotchas

1. **The capture endpoint has to run first.** This endpoint never contacts
   Gmail. Without a stored reply in `support_emails`, every job is skipped with
   a message saying so — it does not silently behave as "nothing to collect".

2. **Do not use `job.updatedAt` as the freshness cutoff.** Capturing the email
   writes `reply_status` back to the job, which bumps `updatedAt` past the
   email's `received_at`. A `received_at > updatedAt` query returns nothing,
   every time. The cutoff is `reply_deadline_at` minus 48 hours, which is the
   run's completion time and is not moved by those writes.

3. **Jobs completed before `reply_deadline_at` existed have no cutoff.** They
   fall back to their newest stored reply. That is deliberate: skipping them
   outright would be worse than being permissive.

4. **The lookup must filter `direction: "incoming"`.** Our own submissions are
   stored under the same `agoda_id` and are frequently newer than Agoda's
   reply, so without the filter the newest record is our own outgoing mail and
   it has no booking IDs on it.

5. **`OTA`, not `ota_provider`.** Both `parent_retrievals` and `retrievals` are
   owned by a Prisma project that maps the field as `OTA`. Renaming it to match
   the `jobs` convention will make those rows invisible to that project.

6. **Ids must be real `ObjectId`s, not strings.** The values copied off the job
   (`property_id`, `user_id`, `portfolio_id`, …) are already `ObjectId`s; do not
   stringify them on the way through.

7. **One parent per API call, not per job.** All candidates in a request share
   a single `parent_retrievals` document. Calling with ten job IDs creates one
   parent and up to ten retrievals.

8. **No `retrieval_items` are created.** Only `reservations[]` on the retrieval
   is populated; the retrieval run fills in the item level itself.

9. **`case_status` becomes `CaseClose` only for jobs whose insert succeeded.**
   Anything in `retrieval.failed` keeps its current status so a later call can
   retry it. `job_status` is never touched — it belongs to the property run.

10. **A per-job exception does not fail the batch.** It is recorded under
    `errors` and the loop continues, matching the other bulk endpoints.

11. **`agoda_id` is a string on `properties`,** and `"0"` means unset.
