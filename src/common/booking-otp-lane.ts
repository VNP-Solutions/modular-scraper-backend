/**
 * Booking OTP is keyed by contact so different phone/slot pairs can run in parallel.
 */

/** Normalized phone digits (or "default") + numeric slot for PhoneNumberSlot rows. */
export function getBookingPhoneSlotForLock(jobData: {
  selectedContact?: { phone?: string; port?: string };
}): { phone_number: string; slot: number } {
  const c = jobData.selectedContact;
  const phone_number =
    c?.phone && String(c.phone).replace(/\D/g, "")
      ? String(c.phone).replace(/\D/g, "")
      : "default";
  let slot = 0;
  if (c?.port != null && String(c.port).trim() !== "") {
    const n = parseInt(String(c.port).trim(), 10);
    slot = Number.isFinite(n) ? n : 0;
  }
  return { phone_number, slot };
}
