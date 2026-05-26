import mongoose, { Document, Schema, Types } from "mongoose";
import { OTAProvider } from "./job.model.js";

/**
 * OTP code received during a scraping job's MFA / passcode flow.
 *
 * One row per code observed (e.g. via SMS relay into MongoDB). Stored so we
 * can audit, retry, or correlate which code was tied to which job + provider.
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
   * Has this code been accepted by the OTA as a successful OTP?
   *
   * Lifecycle:
   *   - `false` (default) → fresh OR previously rejected.
   *   - `true`            → the code the OTA actually accepted.
   *
   * The scraper queries `used: false` to find candidates. It writes
   * `used: true` only after a submit that produced no inline error.
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
OtpCodeSchema.index({ provider: 1, job_id: 1, used: 1 });

export const OtpCode = mongoose.model<IOtpCode>("OtpCode", OtpCodeSchema);
