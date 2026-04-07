/**
 * Worker-pool OTP lock: one lane per phone number (not per port/slot).
 * Different numbers can run on different workers at the same time; same number serializes.
 *
 * `port` on selectedContact is still used by the worker for OTP/email matching only.
 */

/** Normalized digits used for `phone_number_slots` occupancy (ignores port). */
export function getBookingPhoneForLock(jobData: {
  selectedContact?: { phone?: string; port?: string };
}): { phone_number: string } {
  const c = jobData.selectedContact;
  const phone_number =
    c?.phone && String(c.phone).replace(/\D/g, "")
      ? String(c.phone).replace(/\D/g, "")
      : "default";
  return { phone_number };
}

/** Phone + numeric slot from port — for logging or OTP email flows; not used for DB lane key. */
export function getBookingPhoneSlotForLock(jobData: {
  selectedContact?: { phone?: string; port?: string };
}): { phone_number: string; slot: number } {
  const { phone_number } = getBookingPhoneForLock(jobData);
  const c = jobData.selectedContact;
  let slot = 0;
  if (c?.port != null && String(c.port).trim() !== "") {
    const n = parseInt(String(c.port).trim(), 10);
    slot = Number.isFinite(n) ? n : 0;
  }
  return { phone_number, slot };
}
