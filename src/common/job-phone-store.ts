/**
 * Job-scoped phone number and port store.
 * When a job starts, one (phone, port) is randomly picked from the pool and "locked" for that job.
 * All OTP/verification flows use this number; OTP email matching uses Sender + Slot (port).
 */

import dotenv from "dotenv";
dotenv.config();

const DEFAULT_FALLBACK = "01828704004";

export interface JobContact {
  phone: string;
  port?: string;
}

/** jobId -> { phone, port? } for that job */
const jobContacts = new Map<string, JobContact>();

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
 * Picks a random (phone, port) from the pool, stores it for this jobId, and returns the phone.
 * Call once when a job starts.
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
 * Returns the phone to use for OTP/verification for this job.
 * Uses job-locked phone if set, otherwise OUR_CONTACT, otherwise default.
 */
export function getOurContactForJob(jobId: string | undefined): string {
  if (jobId) {
    const locked = jobContacts.get(jobId)?.phone;
    if (locked) return locked;
  }
  return process.env.OUR_CONTACT?.trim() || DEFAULT_FALLBACK;
}

/**
 * Clears the stored contact for this job. Call when job ends.
 */
export function clearJobPhone(jobId: string): void {
  jobContacts.delete(jobId);
}
