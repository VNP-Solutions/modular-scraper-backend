/**
 * Agoda Partner Support email scraper.
 *
 * For each job it resolves the property's Agoda ID, searches Gmail for messages
 * mentioning that ID within a lookback window, takes the newest one, and — only
 * when it came from `PartnerSupport@agoda.com` — parses the body and any
 * CSV / XLSX attachment.
 *
 * Reads only; nothing is persisted. Results are returned to the caller.
 */

import dotenv from "dotenv";
import { google, type gmail_v1 } from "googleapis";
import { loadAndSetCredentials } from "../../common/load-token.js";
import { dualLogError, dualLogInfo, dualLogWarn } from "../../common/log-helper.js";
import { oauth2Client } from "../../config/google-config.js";
import { jobService } from "../../services/job.service.js";
import { downloadAndParseAttachments } from "./attachment-parser.js";
import {
  findHeader,
  normalizeSenderAddress,
  parseSupportEmailBody,
} from "./email-body-parser.js";
import {
  AGODA_PARTNER_SUPPORT_ADDRESS,
  DEFAULT_LOOKBACK_DAYS,
  type BulkSupportEmailResults,
  type JobSupportEmailResult,
  type ParsedAttachment,
  type ReopenSummary,
  type ScrapeSupportEmailOptions,
  type SupportEmail,
  type SupportEmailOutcome,
} from "./support-email.types.js";

dotenv.config();

const DEFAULT_MAX_CANDIDATES = 10;

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
 * Gmail's `newer_than:Nd` keeps the window server-side; quoting the Agoda ID
 * stops Gmail from tokenizing it into unrelated numeric matches.
 */
function buildSearchQuery(agodaId: string, lookbackDays: number): string {
  return `"${agodaId}" newer_than:${lookbackDays}d`;
}

function toIsoDate(internalDate: string | null | undefined): string | null {
  if (!internalDate) return null;
  const millis = Number(internalDate);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/**
 * Gmail lists newest first, but ordering is re-checked against `internalDate`
 * so "the last mail" is right even if the listing order shifts.
 */
async function findNewestMessageId(
  gmail: gmail_v1.Gmail,
  messageIds: string[]
): Promise<string | null> {
  let newestId: string | null = null;
  let newestMillis = -1;

  for (const id of messageIds) {
    try {
      const meta = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["Date"],
      });

      const millis = Number(meta.data.internalDate ?? 0);
      if (millis > newestMillis) {
        newestMillis = millis;
        newestId = id;
      }
    } catch (error) {
      await dualLogWarn(`⚠️ Could not read metadata for message ${id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return newestId;
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
      totalCollectAmountUsd: null,
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

  const amounts = decisions
    .map((decision) => decision.totalCollectAmountUsd)
    .filter((amount): amount is number => amount !== null);

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
    totalCollectAmountUsd:
      amounts.length > 0
        ? Number(amounts.reduce((sum, amount) => sum + amount, 0).toFixed(2))
        : null,
  };
}

async function buildSupportEmail(
  gmail: gmail_v1.Gmail,
  message: gmail_v1.Schema$Message,
  agodaId: string,
  options: ScrapeSupportEmailOptions,
  includeAttachments: boolean
): Promise<SupportEmail> {
  const payload = message.payload ?? undefined;
  const headers = payload?.headers ?? undefined;
  const messageId = message.id as string;

  const attachments = includeAttachments
    ? await downloadAndParseAttachments(gmail, messageId, payload, {
        agodaId,
        reopenRules: options.reopenRules,
      })
    : [];

  return {
    messageId,
    threadId: message.threadId ?? null,
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

  const newestId = await findNewestMessageId(gmail, messageIds);
  if (!newestId) {
    return { status: "no_email_found" };
  }

  const message = await gmail.users.messages.get({
    userId: "me",
    id: newestId,
    format: "full",
  });

  const from = findHeader(message.data.payload?.headers ?? undefined, "From") ?? "";
  const sender = normalizeSenderAddress(from);
  const receivedAt = toIsoDate(message.data.internalDate);

  if (sender !== AGODA_PARTNER_SUPPORT_ADDRESS) {
    await dualLogInfo(
      `↩️ Latest email for Agoda ID ${agodaId} is from ${sender || "unknown"}, not Partner Support`
    );
    return { status: "not_from_partner_support", from, receivedAt };
  }

  await dualLogInfo(
    `✅ Latest email for Agoda ID ${agodaId} is from Agoda Partner Support, parsing`
  );

  const email = await buildSupportEmail(
    gmail,
    message.data,
    agodaId,
    options,
    includeAttachments
  );

  await dualLogInfo(`📄 Parsed support email for Agoda ID ${agodaId}`, {
    caseId: email.body.caseId,
    reservationCount: email.body.reservationIds.length,
    attachmentCount: email.attachments.length,
    shouldReopen: email.reopen.shouldReopen,
    reopenBookings: email.reopen.reopenBookingIds.length,
    collectBookings: email.reopen.collectBookingIds.length,
  });

  return { status: "parsed", email };
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

      const outcome = await scrapeAgodaSupportEmail(
        propertyData.agodaId,
        options
      );

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
