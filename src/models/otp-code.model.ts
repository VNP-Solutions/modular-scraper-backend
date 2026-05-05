import mongoose, { Document, Schema, Types } from "mongoose";
import { OTAProvider } from "./job.model.js";

/**
 * OTP code received during a scraping job's MFA / passcode flow.
 *
 * One row per code we observed (e.g. via Gmail batch fetch in
 * `otp-verification.ts`). Stored so we can audit, retry, or correlate
 * which code was tied to which job + provider.
 */
export interface IOtpCode extends Document {
  _id: Types.ObjectId;
  /** Which OTA the code came from (Expedia / Booking / Agoda). */
  provider: OTAProvider;
  /** The 6-digit verification code as it appeared in the email/SMS. */
  otp_code: string;
  /** Job that triggered this OTP request, if any. */
  job_id?: Types.ObjectId;
  /**
   * Has this code been accepted by Partner Central as a successful OTP?
   *
   * Lifecycle:
   *   - `false` (default) → fresh OR previously rejected. Both states are
   *                          legal; the scraper distinguishes them with an
   *                          in-memory `triedIds` set scoped to the current
   *                          watch window, so a rejected code is not re-tried
   *                          within the same window but the row remains in
   *                          the DB as historical evidence.
   *   - `true`            → the code Partner Central actually accepted
   *                          (i.e. the one that successfully verified the
   *                          session). Set exactly once, only on success.
   *
   * The scraper queries `used: false` to find candidates. It writes
   * `used: true` *only* after a VERIFY click that produced no inline error.
   */
  used: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const OtpCodeSchema = new Schema<IOtpCode>(
  {
    provider: {
      type: String,
      enum: Object.values(OTAProvider),
      required: true,
    },
    otp_code: {
      type: String,
      required: true,
      // Partner Central / Booking / Agoda all use 6-digit numeric codes.
      match: /^\d{6}$/,
    },
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: false,
    },
    used: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: "otp_codes",
  }
);

OtpCodeSchema.index({ job_id: 1 });
OtpCodeSchema.index({ provider: 1 });
OtpCodeSchema.index({ provider: 1, job_id: 1 });
OtpCodeSchema.index({ createdAt: -1 });
// Hot path for the scraper: "give me unused Expedia codes for this job".
OtpCodeSchema.index({ provider: 1, job_id: 1, used: 1 });

export const OtpCode = mongoose.model<IOtpCode>("OtpCode", OtpCodeSchema);
