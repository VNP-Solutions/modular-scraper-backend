/**
 * Job-scoped phone number and port store.
 * When a job starts, one (phone, port) is randomly picked from the pool and "locked" for that job.
 * All OTP/verification flows use this number; OTP email matching uses Sender + Slot (port).
 */

import dotenv from "dotenv";
dotenv.config();

const DEFAULT_FALLBACK = "01828704008";

export interface JobContact {
  phone: string;
  port?: string;
}

/** jobId -> { phone, port? } for that job */
const jobContacts = new Map<string, JobContact>();

/**
 * Booking SMS was sent using OUR_CONTACT from env (UI fallback). OTP email must use legacy
 * IFTTT path without slot filter — 408-style lines often don't match the job's locked port.
 */
const bookingOtpUseNoSlotEmail = new Map<string, boolean>();

/** Round-robin index for even distribution (used when assignContactRoundRobin is true) */
let nextRoundRobinIndex = 0;

/**
 * Parses one contact entry: "phone" or "phone:port".
 * Port is optional (e.g. "01", "9.01" - kept as string).
 */
function parseContactEntry(entry: string): JobContact {
  const trimmed = entry.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    return {
      phone: trimmed.slice(0, colon).trim(),
      port: trimmed.slice(colon + 1).trim().replace(/^["']|["']$/g, ""),
    };
  }
  return { phone: trimmed };
}

/**
 * Returns the pool of contact entries (phone + optional port) from env.
 * OUR_CONTACTS: comma-separated "phone" or "phone:port" (e.g. 18446162011:01,18765551234:02).
 * OUR_CONTACT: single phone (no port).
 */
function getContactPool(): JobContact[] {
  const contactsEnv = process.env.OUR_CONTACTS?.trim();
  if (contactsEnv) {
    const list = contactsEnv
      .split(",")
      .map((s) => parseContactEntry(s))
      .filter((c) => c.phone && c.phone.length > 0);
    if (list.length > 0) return list;
  }
  const single = process.env.OUR_CONTACT?.trim();
  if (single) return [parseContactEntry(single)];
  return [{ phone: DEFAULT_FALLBACK }];
}

/**
 * Returns the next contact in round-robin order (even distribution).
 * Call from main thread when enqueuing a job; pass result as jobData.selectedContact.
 */
export function getNextContactForJob(): JobContact {
  const pool = getContactPool();
  if (pool.length === 0) return { phone: DEFAULT_FALLBACK };
  const index = nextRoundRobinIndex % pool.length;
  nextRoundRobinIndex += 1;
  return { ...pool[index] };
}

/**
 * Sets the contact for a job (used when main thread assigned via round-robin).
 */
export function setJobContact(jobId: string, contact: JobContact): void {
  jobContacts.set(jobId, { ...contact });
}

/**
 * Picks a random (phone, port) from the pool, stores it for this jobId, and returns the phone.
 * Call once when a job starts (used when no selectedContact was passed from main thread).
 */
export function pickRandomPhoneForJob(jobId: string): string {
  const pool = getContactPool();
  const index = Math.floor(Math.random() * pool.length);
  const entry = pool[index];
  jobContacts.set(jobId, { ...entry });
  return entry.phone;
}

/**
 * Returns the phone number locked for this job, or undefined if none set.
 */
export function getJobPhone(jobId: string): string | undefined {
  return jobContacts.get(jobId)?.phone;
}

/**
 * Returns the port (slot) locked for this job, or undefined if none set.
 */
export function getJobPort(jobId: string): string | undefined {
  return jobContacts.get(jobId)?.port;
}

/**
 * Returns { phone, port? } for this job, or undefined if none set.
 */
export function getJobPhoneAndPort(jobId: string): JobContact | undefined {
  return jobContacts.get(jobId);
}

/**
 * OUR_CONTACT env only (no job lock). Used when Booking’s phone picker does not list the
 * job-assigned number — retry matching last-3 against the shared env number.
 */
export function getOurContactFromEnv(): string {
  return process.env.OUR_CONTACT?.trim() || DEFAULT_FALLBACK;
}

/**
 * Returns the phone to use for OTP/verification for this job.
 * Uses job-locked phone if set, otherwise OUR_CONTACT, otherwise default.
 */
export function getOurContactForJob(jobId: string | undefined): string {
  if (jobId) {
    const locked = jobContacts.get(jobId)?.phone;
    if (locked) return locked;
  }
  return getOurContactFromEnv();
}

/**
 * Default OTP phone when a credential group omits phone_number (null / missing / blank).
 * Uses OUR_CONTACT, else built-in fallback (same as single-contact OTP path).
 */
export function getDefaultOtpPhoneForGroupedRequest(): string {
  return getOurContactFromEnv();
}

export function setBookingOtpUseNoSlotEmailForJob(
  jobId: string,
  enabled: boolean
): void {
  if (enabled) {
    bookingOtpUseNoSlotEmail.set(jobId, true);
  } else {
    bookingOtpUseNoSlotEmail.delete(jobId);
  }
}

export function getBookingOtpShouldUseNoSlotEmail(
  jobId: string | undefined
): boolean {
  if (!jobId) return false;
  return bookingOtpUseNoSlotEmail.get(jobId) === true;
}

export function clearBookingOtpUseNoSlotEmailForJob(jobId: string): void {
  bookingOtpUseNoSlotEmail.delete(jobId);
}

/**
 * Clears the stored contact for this job. Call when job ends.
 */
export function clearJobPhone(jobId: string): void {
  jobContacts.delete(jobId);
  bookingOtpUseNoSlotEmail.delete(jobId);
}
