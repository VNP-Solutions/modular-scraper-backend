/**
 * Persists the Agoda Partner Support emails pulled from Gmail.
 *
 * Gmail's `message_id` is the deduplication key: the same message can surface in
 * several runs within the 10-day lookback window, but it is only ever stored
 * once. Nothing is overwritten on a repeat sighting.
 */

import { Types } from "mongoose";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import {
  ISupportEmailAttachment,
  SupportEmail,
} from "../models/support-email.model.js";
import type { SupportEmail as ParsedSupportEmail } from "../agoda/support-email/support-email.types.js";

export interface StoreSupportEmailContext {
  agodaId: string;
  jobId?: string;
  propertyId?: string;
}

export interface StoreSupportEmailResult {
  stored: boolean;
  recordId: string | null;
  /** True when this message was already in the database from an earlier run. */
  duplicate: boolean;
}

function toObjectId(value?: string): Types.ObjectId | undefined {
  if (!value || !Types.ObjectId.isValid(value)) return undefined;
  return new Types.ObjectId(value);
}

/**
 * Only metadata is kept. The rows themselves stay in the archived file on S3,
 * so the record cannot drift from what Agoda actually sent.
 */
function toStorableAttachments(
  email: ParsedSupportEmail
): ISupportEmailAttachment[] {
  return email.attachments.map((attachment) => ({
    filename: attachment.filename,
    mime_type: attachment.mimeType,
    size_bytes: attachment.sizeBytes,
    format: attachment.format,
    columns: attachment.columns,
    row_count: attachment.rowCount,
    sheet_type: attachment.reopenDecision?.sheetType,
    parse_error: attachment.parseError,
    s3_url: attachment.s3Url ?? null,
    s3_key: attachment.s3Key ?? null,
    upload_error: attachment.uploadError,
  }));
}

export class SupportEmailService {
  /** Whether this Gmail message has already been captured. */
  async isStored(messageId: string): Promise<boolean> {
    const existing = await SupportEmail.findOne({ message_id: messageId })
      .select("_id")
      .lean();
    return Boolean(existing);
  }

  /**
   * Stores the email unless its `message_id` is already on record.
   * Never throws — a storage problem must not fail the scrape.
   */
  async storeIfNew(
    email: ParsedSupportEmail,
    context: StoreSupportEmailContext
  ): Promise<StoreSupportEmailResult> {
    try {
      const existing = await SupportEmail.findOne({
        message_id: email.messageId,
      })
        .select("_id")
        .lean();

      if (existing) {
        await dualLogInfo(
          `🗃️ Support email ${email.messageId} already stored, skipping`,
          { agodaId: context.agodaId, jobId: context.jobId }
        );
        return {
          stored: false,
          recordId: String(existing._id),
          duplicate: true,
        };
      }

      const created = await SupportEmail.create({
        message_id: email.messageId,
        thread_id: email.threadId,
        direction: email.direction,
        agoda_id: context.agodaId,
        job_id: toObjectId(context.jobId),
        property_id: toObjectId(context.propertyId),

        from_address: email.headers.from,
        to_address: email.headers.to,
        subject: email.headers.subject,
        date_header: email.headers.date,
        received_at: email.receivedAt ? new Date(email.receivedAt) : null,

        body_text: email.body.text,
        case_id: email.body.caseId,
        property_name: email.body.propertyName,
        city: email.body.city,
        country: email.body.country,
        reservation_ids: email.body.reservationIds,
        partner_email: email.body.partnerEmail,

        attachments: toStorableAttachments(email),

        should_reopen: email.reopen.shouldReopen,
        reopen_booking_ids: email.reopen.reopenBookingIds,
        collect_booking_ids: email.reopen.collectBookingIds,
      });

      await dualLogInfo(`🗃️ Stored support email ${email.messageId}`, {
        agodaId: context.agodaId,
        jobId: context.jobId,
        direction: email.direction,
        caseId: email.body.caseId,
        attachmentCount: email.attachments.length,
        recordId: String(created._id),
      });

      return { stored: true, recordId: String(created._id), duplicate: false };
    } catch (error: any) {
      // A concurrent run inserted the same message between our check and write.
      if (error?.code === 11000) {
        return { stored: false, recordId: null, duplicate: true };
      }

      await dualLogError(
        `Failed to store support email ${email.messageId}:`,
        error,
        { agodaId: context.agodaId, jobId: context.jobId }
      );
      return { stored: false, recordId: null, duplicate: false };
    }
  }
}

export const supportEmailService = new SupportEmailService();
