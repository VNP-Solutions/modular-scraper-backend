import dotenv from "dotenv";
import { Types } from "mongoose";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { Job, OTAProvider } from "../models/job.model.js";
import { OtpCode } from "../models/otp-code.model.js";

dotenv.config();

export interface PendingOtpCode {
  _id: Types.ObjectId;
  otp_code: string;
}

export type OtpSubmitResult = "accepted" | "rejected";

/**
 * Hard cap on how long we wait for an OTP code to land in `otp_codes`.
 * Default: 10 minutes.
 */
export const OTP_DB_WAIT_MAX_MS =
  Number(process.env.OTP_DB_WAIT_MAX_MS) || 10 * 60 * 1000;

/** How often we re-query `otp_codes` while waiting. Default: 5 seconds. */
export const OTP_DB_POLL_INTERVAL_MS =
  Number(process.env.OTP_DB_POLL_INTERVAL_MS) || 5 * 1000;

/** Brief pause between submit attempts when cycling codes within the watch window. */
const OTP_WAIT_BETWEEN_SUBMIT_MS =
  Number(process.env.OTP_WAIT_BETWEEN_SUBMIT_MS) ||
  Number(process.env.OTP_WAIT_BETWEEN_RETRY_MS) ||
  2 * 1000;

const QUIET_LOG_EVERY_N_POLLS = 6;

/**
 * Single-pass query for fresh, unused OTP codes for this job + provider.
 *
 * - `used: false` filters out codes already tried successfully or still rejected
 *   in a prior window (rejected codes stay false but are skipped via `triedIds`).
 * - `createdAt >= fromDate` filters out stale codes from a previous OTP attempt.
 */
export async function queryUnusedOtpCodes(
  provider: OTAProvider,
  jobId: string,
  fromDate: Date
): Promise<PendingOtpCode[]> {
  try {
    const docs = await OtpCode.find({
      provider,
      job_id: jobId,
      used: false,
      createdAt: { $gte: fromDate },
    })
      .sort({ createdAt: -1 })
      .select({ _id: 1, otp_code: 1 })
      .lean();

    return docs.map((d) => ({ _id: d._id, otp_code: d.otp_code }));
  } catch (queryError) {
    await dualLogError(
      `otp_codes query failed (will retry on next poll):`,
      queryError
    );
    return [];
  }
}

/** Flip an OTP code's `used` flag to `true` after the OTA accepted it. */
export async function markOtpCodeUsed(otpCodeId: Types.ObjectId): Promise<void> {
  try {
    await OtpCode.updateOne(
      { _id: otpCodeId, used: false },
      { $set: { used: true } }
    );
  } catch (markError) {
    await dualLogError(
      `Failed to mark otp_codes._id=${otpCodeId} as used (will continue):`,
      markError
    );
  }
}

/** Best-effort: set `jobs.otp_needed` for consumers watching this job. */
export async function setJobOtpNeededFlag(
  jobId: string,
  otpNeeded: boolean
): Promise<void> {
  try {
    await Job.updateOne({ _id: jobId }, { $set: { otp_needed: otpNeeded } });
  } catch (err) {
    await dualLogError(
      `Failed to set job otp_needed=${otpNeeded} for job ${jobId}:`,
      err
    );
  }
}

/** Best-effort: set `jobs.otp_fulfilled=true` once the job completes after OTP. */
export async function setJobOtpFulfilledFlag(jobId: string): Promise<void> {
  try {
    await Job.updateOne({ _id: jobId }, { $set: { otp_fulfilled: true } });
  } catch (err) {
    await dualLogError(
      `Failed to set job otp_fulfilled=true for job ${jobId}:`,
      err
    );
  }
}

/**
 * Watch `otp_codes` (provider + job_id) for the entire `waitTimeoutMs` window.
 * Submits each new unused code via `submitCode`; on acceptance marks the doc
 * used and sets job OTP flags.
 */
export async function watchOtpCodesFromDb(
  jobId: string,
  provider: OTAProvider,
  submitCode: (
    code: string,
    submitIndex: number,
    otpCodeId: Types.ObjectId
  ) => Promise<OtpSubmitResult>,
  options?: { waitTimeoutMs?: number }
): Promise<void> {
  const waitTimeoutMs = options?.waitTimeoutMs ?? OTP_DB_WAIT_MAX_MS;
  const start = Date.now();
  const fromDate = new Date(start);
  const triedIds = new Set<string>();

  let pollCount = 0;
  let submitCount = 0;

  await dualLogInfo(
    `Watching otp_codes for ${provider} OTP (job=${jobId}, used=false) for up to ${
      waitTimeoutMs / 60000
    } min, polling every ${OTP_DB_POLL_INTERVAL_MS / 1000}s...`
  );

  await setJobOtpNeededFlag(jobId, true);

  while (Date.now() - start < waitTimeoutMs) {
    pollCount++;

    const allCandidates = await queryUnusedOtpCodes(provider, jobId, fromDate);
    const candidates = allCandidates.filter(
      (c) => !triedIds.has(c._id.toString())
    );

    if (candidates.length === 0) {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      const remainingSec = Math.max(
        0,
        Math.round((waitTimeoutMs - (Date.now() - start)) / 1000)
      );
      if (pollCount % QUIET_LOG_EVERY_N_POLLS === 0) {
        await dualLogInfo(
          `Still watching otp_codes (poll #${pollCount}, ${elapsedSec}s elapsed, ${remainingSec}s remaining, ${submitCount} submit(s) so far)...`
        );
      }
      await delay(OTP_DB_POLL_INTERVAL_MS);
      continue;
    }

    await dualLogInfo(
      `Poll #${pollCount}: found ${candidates.length} new unused code(s); submitting newest-first.`
    );

    for (const candidate of candidates) {
      if (Date.now() - start >= waitTimeoutMs) {
        break;
      }

      const { _id: pendingId, otp_code: code } = candidate;
      triedIds.add(pendingId.toString());
      submitCount++;

      const elapsedSec = Math.round((Date.now() - start) / 1000);
      await dualLogInfo(
        `OTP submit #${submitCount} (${elapsedSec}s into ${
          waitTimeoutMs / 60000
        }-min window): trying code ${code}`
      );

      const result = await submitCode(code, submitCount, pendingId);

      if (result === "accepted") {
        await markOtpCodeUsed(pendingId);
        await dualLogInfo(
          `OTP accepted on submit #${submitCount} after ${elapsedSec}s; otp_codes._id=${pendingId} marked used=true.`
        );
        await setJobOtpNeededFlag(jobId, false);
        return;
      }

      const remainingSec = Math.max(
        0,
        Math.round((waitTimeoutMs - (Date.now() - start)) / 1000)
      );
      await dualLogInfo(
        `OTP rejected (otp_codes._id=${pendingId} kept used=false); will keep watching otp_codes for newer codes (${remainingSec}s remaining in window).`
      );
      await delay(OTP_WAIT_BETWEEN_SUBMIT_MS);
    }
  }

  await setJobOtpNeededFlag(jobId, false);

  if (submitCount === 0) {
    throw new Error(
      `Failed to get verification code from otp_codes within ${
        waitTimeoutMs / 60000
      } minute(s) (provider=${provider}, job=${jobId}, polls=${pollCount}).`
    );
  }

  throw new Error(
    `OTP verification failed: tried ${submitCount} code(s) within ${
      waitTimeoutMs / 60000
    } minute(s); all rejected (provider=${provider}, job=${jobId}, polls=${pollCount}).`
  );
}
