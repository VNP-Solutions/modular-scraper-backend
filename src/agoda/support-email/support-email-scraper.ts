/**
 * Agoda Partner Support email scraper.
 *
 * For each job it resolves the property's Agoda ID, searches the Agoda label in
 * Gmail for messages mentioning that ID within a lookback window, takes the
 * newest one sent by `PartnerSupport@agoda.com`, and parses its body and any
 * CSV / XLSX attachment.
 *
 * The captured email is persisted once per Gmail message; results are also
 * returned to the caller.
 */

import dotenv from "dotenv";
import { google, type gmail_v1 } from "googleapis";
import { loadAndSetCredentials } from "../../common/load-token.js";
import { dualLogError, dualLogInfo, dualLogWarn } from "../../common/log-helper.js";
import { oauth2Client } from "../../config/google-config.js";
import { jobService } from "../../services/job.service.js";
import { supportEmailService } from "../../services/support-email.service.js";
import { downloadAndParseAttachments } from "./attachment-parser.js";
import {
  findHeader,
  normalizeSenderAddress,
  parseSupportEmailBody,
} from "./email-body-parser.js";
import {
  AGODA_PARTNER_SUPPORT_ADDRESS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_SUPPORT_EMAIL_LABEL,
  type BulkSupportEmailResults,
  type JobSupportEmailResult,
  type ParsedAttachment,
  type ReopenSummary,
  type ScrapeSupportEmailOptions,
  type SupportEmail,
  type SupportEmailDirection,
  type SupportEmailOutcome,
} from "./support-email.types.js";

dotenv.config();

const DEFAULT_MAX_CANDIDATES = 10;

const SUPPORT_EMAIL_LABEL =
  process.env.AGODA_SUPPORT_EMAIL_LABEL || DEFAULT_SUPPORT_EMAIL_LABEL;

async function getGmailClient(): Promise<gmail_v1.Gmail> {
  const tokenPath = process.env.TOKEN_PATH || "token.json";
  const loaded = await loadAndSetCredentials(tokenPath);

  if (!loaded) {
    throw new Error(
      "Failed to load Gmail credentials. Complete the Google OAuth setup at /auth first."
    );
  }

  return google.gmail({ version: "v1", auth: oauth2Client });
}

/**
 * Scoped to the Agoda label so the whole conversation is in range, replies and
 * sent mail included. Gmail's `newer_than:Nd` keeps the window server-side, and
 * quoting the Agoda ID stops Gmail from tokenizing it into unrelated numeric
 * matches. The label is quoted too, so a renamed label containing spaces still
 * works.
 */
function buildSearchQuery(agodaId: string, lookbackDays: number): string {
  return `label:"${SUPPORT_EMAIL_LABEL}" "${agodaId}" newer_than:${lookbackDays}d`;
}

function toIsoDate(internalDate: string | null | undefined): string | null {
  if (!internalDate) return null;
  const millis = Number(internalDate);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

interface CandidateMessage {
  id: string;
  millis: number;
  from: string;
  sender: string;
  receivedAt: string | null;
  direction: SupportEmailDirection;
}

/**
 * Loads just enough of each hit to order and attribute it, newest first. Gmail
 * lists newest first already, but ordering is re-derived from `internalDate` so
 * "the last mail" is right even if the listing order shifts.
 */
async function loadCandidates(
  gmail: gmail_v1.Gmail,
  messageIds: string[]
): Promise<CandidateMessage[]> {
  const candidates: CandidateMessage[] = [];

  for (const id of messageIds) {
    try {
      const meta = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["Date", "From"],
      });

      const from =
        findHeader(meta.data.payload?.headers ?? undefined, "From") ?? "";

      candidates.push({
        id,
        millis: Number(meta.data.internalDate ?? 0),
        from,
        sender: normalizeSenderAddress(from),
        receivedAt: toIsoDate(meta.data.internalDate),
        // Gmail's own SENT label is more reliable than matching the From
        // address against whichever alias the mailbox happens to send as.
        direction: (meta.data.labelIds ?? []).includes("SENT")
          ? "outgoing"
          : "incoming",
      });
    } catch (error) {
      await dualLogWarn(`⚠️ Could not read metadata for message ${id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return candidates.sort((a, b) => b.millis - a.millis);
}

/** Rolls the per-attachment verdicts up into one answer for the email. */
function summarizeReopen(attachments: ParsedAttachment[]): ReopenSummary {
  const decisions = attachments
    .map((attachment) => attachment.reopenDecision)
    .filter((decision): decision is NonNullable<typeof decision> =>
      Boolean(decision)
    );

  if (decisions.length === 0) {
    return {
      shouldReopen: false,
      reason: "No tabular attachment to evaluate",
      reopenBookingIds: [],
      collectBookingIds: [],
    };
  }

  const dedupe = (ids: string[]) => [...new Set(ids.filter(Boolean))];

  const reopenBookingIds = dedupe(
    decisions.flatMap((decision) =>
      decision.reopen.map((entry) => entry.bookingId)
    )
  );
  const collectBookingIds = dedupe(
    decisions.flatMap((decision) =>
      decision.collect.map((entry) => entry.bookingId)
    )
  );

  const reasonParts: string[] = [];
  if (reopenBookingIds.length > 0) {
    reasonParts.push(`${reopenBookingIds.length} booking(s) need the case reopened`);
  }
  if (collectBookingIds.length > 0) {
    reasonParts.push(`${collectBookingIds.length} booking(s) can be collected`);
  }

  return {
    shouldReopen: decisions.some((decision) => decision.shouldReopen),
    reason: reasonParts.join(", ") || "Nothing outstanding in the report",
    reopenBookingIds,
    collectBookingIds,
  };
}

async function buildSupportEmail(
  gmail: gmail_v1.Gmail,
  message: gmail_v1.Schema$Message,
  agodaId: string,
  options: ScrapeSupportEmailOptions,
  includeAttachments: boolean,
  direction: SupportEmailDirection
): Promise<SupportEmail> {
  const payload = message.payload ?? undefined;
  const headers = payload?.headers ?? undefined;
  const messageId = message.id as string;

  const attachments = includeAttachments
    ? await downloadAndParseAttachments(gmail, messageId, payload, {
        agodaId,
        reopenRules: options.reopenRules,
        // A run that is not writing the record should not leave an orphaned
        // file behind either.
        uploadToS3: options.persist !== false,
      })
    : [];

  return {
    messageId,
    threadId: message.threadId ?? null,
    direction,
    receivedAt: toIsoDate(message.internalDate),
    headers: {
      from: findHeader(headers, "From") ?? "",
      to: findHeader(headers, "To"),
      subject: findHeader(headers, "Subject"),
      date: findHeader(headers, "Date"),
    },
    body: parseSupportEmailBody(payload),
    attachments,
    reopen: summarizeReopen(attachments),
  };
}

/**
 * Stores the rest of the labelled conversation — our own submissions and any
 * older replies — so the exchange is on record, not just the one message the
 * reopen rules ran against.
 *
 * Messages already captured by an earlier run are skipped before Gmail is asked
 * for the body, so a repeat scrape costs one cheap database lookup each.
 */
async function captureRemainingConversation(
  gmail: gmail_v1.Gmail,
  candidates: CandidateMessage[],
  primaryMessageId: string,
  agodaId: string,
  options: ScrapeSupportEmailOptions,
  includeAttachments: boolean
): Promise<{ stored: number; duplicates: number }> {
  let stored = 0;
  let duplicates = 0;

  for (const candidate of candidates) {
    if (candidate.id === primaryMessageId) continue;

    try {
      if (await supportEmailService.isStored(candidate.id)) {
        duplicates += 1;
        continue;
      }

      const message = await gmail.users.messages.get({
        userId: "me",
        id: candidate.id,
        format: "full",
      });

      const email = await buildSupportEmail(
        gmail,
        message.data,
        agodaId,
        options,
        includeAttachments,
        candidate.direction
      );

      const result = await supportEmailService.storeIfNew(email, {
        agodaId,
        jobId: options.jobId,
        propertyId: options.propertyId,
      });

      if (result.stored) stored += 1;
      else if (result.duplicate) duplicates += 1;
    } catch (error) {
      // One unreadable message must not cost us the rest of the conversation.
      await dualLogWarn(
        `⚠️ Could not capture conversation message ${candidate.id}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  return { stored, duplicates };
}

/**
 * Finds and parses the latest Agoda Partner Support reply for one Agoda ID.
 */
export async function scrapeAgodaSupportEmail(
  agodaId: string,
  options: ScrapeSupportEmailOptions = {}
): Promise<SupportEmailOutcome> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const includeAttachments = options.includeAttachments ?? true;

  const gmail = await getGmailClient();
  const query = buildSearchQuery(agodaId, lookbackDays);

  await dualLogInfo(`📧 Searching Gmail for Agoda ID ${agodaId}`, { query });

  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults: maxCandidates,
    q: query,
  });

  const messageIds = (list.data.messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));

  if (messageIds.length === 0) {
    await dualLogInfo(
      `📭 No emails mentioning Agoda ID ${agodaId} in the last ${lookbackDays} days`
    );
    return { status: "no_email_found" };
  }

  await dualLogInfo(
    `📬 Found ${messageIds.length} candidate email(s) for Agoda ID ${agodaId}`
  );

  const candidates = await loadCandidates(gmail, messageIds);
  if (candidates.length === 0) {
    return { status: "no_email_found" };
  }

  // The label covers both directions, so the newest hit is often our own reply.
  // Take the newest message Agoda actually sent rather than stopping at the
  // newest overall and calling it a day.
  const latestReply = candidates.find(
    (candidate) => candidate.sender === AGODA_PARTNER_SUPPORT_ADDRESS
  );

  if (!latestReply) {
    const newest = candidates[0];
    await dualLogInfo(
      `↩️ No Partner Support message among the ${candidates.length} hit(s) for Agoda ID ${agodaId}; newest is from ${newest.sender || "unknown"}`
    );
    return {
      status: "not_from_partner_support",
      from: newest.from,
      receivedAt: newest.receivedAt,
    };
  }

  const message = await gmail.users.messages.get({
    userId: "me",
    id: latestReply.id,
    format: "full",
  });

  await dualLogInfo(
    `✅ Latest Partner Support reply for Agoda ID ${agodaId} received ${latestReply.receivedAt}, parsing`
  );

  const email = await buildSupportEmail(
    gmail,
    message.data,
    agodaId,
    options,
    includeAttachments,
    latestReply.direction
  );

  await dualLogInfo(`📄 Parsed support email for Agoda ID ${agodaId}`, {
    caseId: email.body.caseId,
    reservationCount: email.body.reservationIds.length,
    attachmentCount: email.attachments.length,
    shouldReopen: email.reopen.shouldReopen,
    reopenBookings: email.reopen.reopenBookingIds.length,
    collectBookings: email.reopen.collectBookingIds.length,
  });

  if (options.persist === false) {
    return {
      status: "parsed",
      email,
      storage: {
        stored: false,
        duplicate: false,
        recordId: null,
        conversationStored: 0,
        conversationDuplicates: 0,
      },
    };
  }

  // Gmail keeps returning the same message for the whole lookback window, so
  // the store is a no-op after the first sighting.
  const primaryStorage = await supportEmailService.storeIfNew(email, {
    agodaId,
    jobId: options.jobId,
    propertyId: options.propertyId,
  });

  const conversation = await captureRemainingConversation(
    gmail,
    candidates,
    latestReply.id,
    agodaId,
    options,
    includeAttachments
  );

  if (conversation.stored > 0) {
    await dualLogInfo(
      `🗂️ Captured ${conversation.stored} further message(s) from the Agoda ${agodaId} conversation`
    );
  }

  return {
    status: "parsed",
    email,
    storage: {
      ...primaryStorage,
      conversationStored: conversation.stored,
      conversationDuplicates: conversation.duplicates,
    },
  };
}

/**
 * Runs the scrape for a batch of job IDs, isolating per-job failures the same
 * way the Agoda bulk property run endpoint does.
 */
export async function scrapeSupportEmailsForJobs(
  jobIds: string[],
  options: ScrapeSupportEmailOptions = {}
): Promise<BulkSupportEmailResults> {
  const results: BulkSupportEmailResults = {
    processed: [],
    invalid: [],
    errors: [],
  };

  for (const jobId of jobIds) {
    try {
      const job = await jobService.getJobById(jobId);
      if (!job) {
        results.invalid.push({ jobId, reason: "Job not found" });
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

      const outcome = await scrapeAgodaSupportEmail(propertyData.agodaId, {
        ...options,
        jobId,
        propertyId: job.property_id?.toString(),
      });

      const result: JobSupportEmailResult = {
        jobId,
        agodaId: propertyData.agodaId,
        outcome,
      };
      results.processed.push(result);
    } catch (error: any) {
      await dualLogError(
        `Error scraping Agoda support email for job ${jobId}:`,
        error
      );
      results.errors.push({
        jobId,
        error: error?.message || String(error),
      });
    }
  }

  return results;
}
