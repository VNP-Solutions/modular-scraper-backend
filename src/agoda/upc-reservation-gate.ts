/**
 * Synchronizes incremental DB save + UPC: the API mapping loop waits until UPC has fully
 * finished each reservation (including payout / OTP) before continuing to the next summary fetch.
 * Prevents cookie/session contention and confusing interleaved logs between the two tabs.
 */
export class UpcReservationGate {
  private readonly waiters = new Map<string, Array<() => void>>();

  /** Block until `notifyReservationComplete` is called for this id (after UPC finishes that booking). */
  waitUntilUpcDoneForReservation(reservationId: string): Promise<void> {
    return new Promise((resolve) => {
      const id = String(reservationId).trim();
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  /** Call once UPC is done with this reservation (success, no card, or error). */
  notifyReservationComplete(reservationId: string): void {
    const id = String(reservationId).trim();
    const list = this.waiters.get(id);
    if (!list?.length) return;
    for (const resolve of list) resolve();
    this.waiters.delete(id);
  }
}
