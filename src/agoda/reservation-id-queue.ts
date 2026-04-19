/**
 * Async queue of reservation IDs for streaming UPC while the API mapping loop runs.
 */
export class ReservationIdQueue {
  private readonly pending: string[] = [];
  private notify: (() => void) | null = null;
  private closed = false;

  enqueue(id: string): void {
    if (this.closed) return;
    this.pending.push(id);
    this.notify?.();
    this.notify = null;
  }

  /** Signal that no more IDs will be enqueued; consumer drains and exits. */
  close(): void {
    this.closed = true;
    this.notify?.();
    this.notify = null;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Next ID, or `undefined` when closed and empty. */
  async next(): Promise<string | undefined> {
    for (;;) {
      const id = this.pending.shift();
      if (id !== undefined) return id;
      if (this.closed) return undefined;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }
}
