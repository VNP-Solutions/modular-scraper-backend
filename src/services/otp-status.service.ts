import { Types } from "mongoose";
import { OtpPlatform, OtpStatus, OtpStatusValue } from "../models/otp-status.model.js";

/**
 * Generic single-document-per-platform OTP/email-verification mutex, backed
 * by the `otp_statuses` collection (one doc per {@link OtpPlatform}, e.g.
 * `{ status: "Released", platform: "trip.com" }`).
 *
 * This is intentionally much simpler than Booking's `phone_number_slots`
 * multi-lane system (`OtpStatusManager`) — platforms using this service
 * (Expedia/Agoda-style, and now Trip.com) only have ONE shared inbox to
 * poll for verification emails/links, so only one job at a time may be
 * actively waiting on/consuming it, full stop. There's no per-phone-number
 * fan-out to reason about.
 *
 * Usage pattern (see TripScraper.handle2FA / solveVccOtpChallenge):
 *   1. Right before starting to poll the shared inbox, `waitAndAcquire()`.
 *   2. Wrap the poll+consume logic in try/finally.
 *   3. In the `finally`, always `release()` — regardless of whether the
 *      email/link was found or the verification itself succeeded — so a
 *      failed job never leaves the lock stuck Occupied forever.
 */
export class OtpStatusService {
  /**
   * Ensure a doc exists for this platform (first-run bootstrap). Safe to
   * call repeatedly; swallows a duplicate-key race from a concurrent
   * caller doing the same thing.
   */
  private async ensureDocExists(platform: OtpPlatform): Promise<void> {
    const existing = await OtpStatus.findOne({ platform }).lean();
    if (existing) return;

    try {
      await OtpStatus.create({ platform, status: OtpStatusValue.Released });
    } catch {
      // Another process created it first — fine, that's what we wanted.
    }
  }

  /**
   * Single atomic attempt to occupy the platform's lock for `jobId`.
   * Returns false (without side effects) if it's already Occupied by
   * someone else.
   */
  async acquire(platform: OtpPlatform, jobId: string): Promise<boolean> {
    await this.ensureDocExists(platform);

    const update: { status: OtpStatusValue; job_id?: Types.ObjectId } = {
      status: OtpStatusValue.Occupied,
    };
    if (Types.ObjectId.isValid(jobId)) {
      update.job_id = new Types.ObjectId(jobId);
    }

    const acquired = await OtpStatus.findOneAndUpdate(
      { platform, status: OtpStatusValue.Released },
      update,
      { new: true }
    );

    return acquired !== null;
  }

  /**
   * Poll `acquire()` until it succeeds or `maxWaitMs` elapses. Returns
   * false on timeout (caller should fail the job with a clear reason
   * rather than proceeding without the lock).
   */
  async waitAndAcquire(
    platform: OtpPlatform,
    jobId: string,
    options?: {
      maxWaitMs?: number;
      pollIntervalMs?: number;
      onWaiting?: (elapsedMs: number) => void | Promise<void>;
    }
  ): Promise<boolean> {
    const maxWaitMs = options?.maxWaitMs ?? 10 * 60 * 1000; // 10 minutes
    const pollIntervalMs = options?.pollIntervalMs ?? 5_000;
    const startedAt = Date.now();

    while (true) {
      const acquired = await this.acquire(platform, jobId);
      if (acquired) return true;

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) return false;

      if (options?.onWaiting) {
        await options.onWaiting(elapsedMs);
      }

      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, maxWaitMs - elapsedMs))
      );
    }
  }

  /**
   * Release the platform's lock back to Released. When `jobId` is a valid
   * ObjectId, only releases a doc still held by that exact job (avoids
   * stomping another job's legitimately-held lock in a
   * lost-the-lock-then-still-ran edge case). If nothing matched that
   * filter (e.g. `job_id` was never recorded because the caller had no
   * real jobId, or the doc was reset externally), falls back to an
   * unconditional release by platform — leaving the lock permanently
   * Occupied would deadlock every future job far worse than an
   * over-eager release here.
   */
  async release(platform: OtpPlatform, jobId?: string): Promise<void> {
    if (jobId && Types.ObjectId.isValid(jobId)) {
      const result = await OtpStatus.updateOne(
        { platform, job_id: new Types.ObjectId(jobId) },
        { status: OtpStatusValue.Released, job_id: null }
      );
      if (result.matchedCount > 0) return;
    }

    await OtpStatus.updateOne(
      { platform },
      { status: OtpStatusValue.Released, job_id: null }
    );
  }

  async getStatus(platform: OtpPlatform): Promise<{
    status: OtpStatusValue;
    jobId: string | null;
  } | null> {
    const doc = await OtpStatus.findOne({ platform }).lean();
    if (!doc) return null;
    return {
      status: doc.status,
      jobId: doc.job_id ? doc.job_id.toString() : null,
    };
  }
}

export const otpStatusService = new OtpStatusService();
