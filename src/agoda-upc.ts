import { Browser } from "puppeteer";
import {
  buildAgodaBookingListUrl,
  collectUpcForBookingId,
  formatExpiryForStorage,
  isRecoverableUpcNavigationError,
  openBookingListPage,
  recoverUpcBookingListTab,
  type UpcCollectSession,
} from "./agoda/upc/upc-booking-flow.js";
import { delay } from "./common/delay.js";
import { ReservationIdQueue } from "./agoda/reservation-id-queue.js";
import type { UpcReservationGate } from "./agoda/upc-reservation-gate.js";
import { dualLogError, dualLogInfo } from "./common/log-helper.js";
import { progressManager } from "./common/progress-manager.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { CardInfo } from "./models/job-item.model.js";
import { jobService } from "./services/job.service.js";

export interface AgodaUpcPhaseResult {
  bookingIdsRequested: number;
  bookingIdsSucceeded: number;
  bookingIdsFailed: string[];
}

export { ReservationIdQueue };

/**
 * Consumes reservation IDs from a queue (fed while API mapping runs, or pre-filled for batch).
 * Opens one booking-list tab and processes IDs sequentially.
 */
export async function runAgodaUpcPhaseStreaming(
  browser: Browser,
  params: {
    jobId: string;
    agodaId: string;
    agodaUsername?: string;
    listStartDate: string;
    listEndDate: string;
    queue: ReservationIdQueue;
    /** When set, UPC calls `notifyReservationComplete` after each id so the API loop can await per row */
    gate?: UpcReservationGate;
    /** When true, log that UPC overlaps the booking-summary API loop (ignored if `gate` is set) */
    concurrentWithApiMapping?: boolean;
  }
): Promise<AgodaUpcPhaseResult> {
  const {
    jobId,
    agodaId,
    agodaUsername,
    listStartDate,
    listEndDate,
    queue,
    gate,
    concurrentWithApiMapping,
  } = params;

  const failed: string[] = [];
  let succeeded = 0;
  let processed = 0;

  let listPage: import("puppeteer").Page | null = null;
  /**
   * Declared out here so the `finally` block's OTP release safety net can
   * observe `otpReleased` even if the try block throws before setting it.
   */
  const upcCollectSessionRef: UpcCollectSession = {};

  try {
    await dualLogInfo(
      gate
        ? "Agoda UPC streaming: starting (serialized with API — one reservation at a time)"
        : concurrentWithApiMapping
          ? "Agoda UPC streaming: starting (parallel with booking-summary API loop)"
          : "Agoda UPC streaming: starting",
      { jobId, agodaId }
    );

    listPage = await openBookingListPage(
      browser,
      agodaId,
      listStartDate,
      listEndDate,
      jobId
    );

    let bookingListUrlLive =
      listPage.url().split("#")[0]?.trim() ||
      buildAgodaBookingListUrl(agodaId, listStartDate, listEndDate);

    const upcCollectSession: UpcCollectSession = upcCollectSessionRef;

    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        96,
        "agoda_upc_booking_list_open",
        undefined
      );
    }

    for (;;) {
      const bookingId = await queue.next();
      if (bookingId === undefined) break;

      try {
      processed++;
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogInfo("UPC streaming stopped with scraping", { jobId });
        break;
      }

      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          Math.min(96 + Math.floor(processed * 0.1), 99),
          `agoda_upc_stream_${processed}`,
          undefined
        );
      }

      const maxCollectAttempts = 5;
      let upc: Awaited<ReturnType<typeof collectUpcForBookingId>> = null;
      let collectAbortWithError = false;

      for (let att = 1; att <= maxCollectAttempts; att++) {
        try {
          upc = await collectUpcForBookingId(
            listPage,
            bookingListUrlLive,
            bookingId,
            agodaUsername,
            jobId,
            upcCollectSession
          );
          break;
        } catch (oneErr: unknown) {
          const msg =
            oneErr instanceof Error ? oneErr.message : String(oneErr);
          if (
            isRecoverableUpcNavigationError(oneErr) &&
            att < maxCollectAttempts
          ) {
            const softOnly = att <= 3;
            if (softOnly) {
              const waitMs = att === 1 ? 25000 : att === 2 ? 30000 : 35000;
              await dualLogInfo(
                `UPC: navigation/context reset during verification — waiting ${waitMs}ms for Universal Login to finish (no list reload yet) (${att}/${maxCollectAttempts})`,
                { jobId, bookingId, detail: msg }
              );
              await delay(waitMs);
              continue;
            }
            await dualLogInfo(
              `UPC: verification still failing after long waits — reloading booking list and retrying (${att}/${maxCollectAttempts})`,
              { jobId, bookingId, detail: msg }
            );
            await recoverUpcBookingListTab(
              listPage,
              bookingListUrlLive,
              jobId
            );
            bookingListUrlLive =
              listPage.url().split("#")[0]?.trim() || bookingListUrlLive;
            continue;
          }
          await dualLogError(`UPC: error for booking ${bookingId}`, msg, {
            jobId,
            bookingId,
          });
          failed.push(bookingId);
          collectAbortWithError = true;
          break;
        }
      }

      if (collectAbortWithError) {
        continue;
      }

      if (
        !upc?.cardNumber ||
        !upc.expirationDate ||
        upc.cardNumber.length < 12
      ) {
        await dualLogInfo(`UPC: no valid widget data for ${bookingId}`, {
          jobId,
        });
        failed.push(bookingId);
        continue;
      }

      try {
        const item = await jobService.getJobItemByReservation(
          jobId,
          bookingId
        );
        if (!item) {
          await dualLogInfo(
            `UPC: no job_item for reservation ${bookingId} yet; skip save`,
            { jobId }
          );
          failed.push(bookingId);
          continue;
        }

        const cardInfo: CardInfo = {
          card_number: upc.cardNumber,
          expiry_date: formatExpiryForStorage(upc.expirationDate),
          cvv: upc.cvcCode || undefined,
          reason_for_charge: upc.cardHolderName || undefined,
        };

        const updated = await jobService.updateJobItemCardInfoByReservation(
          jobId,
          bookingId,
          cardInfo
        );

        if (updated) {
          succeeded++;
          await dualLogInfo(`UPC: saved card info for ${bookingId}`, { jobId });
        } else {
          failed.push(bookingId);
        }
      } catch (persistErr: unknown) {
        await dualLogError(
          `UPC: error persisting card for ${bookingId}`,
          persistErr instanceof Error ? persistErr.message : persistErr,
          { jobId, bookingId }
        );
        failed.push(bookingId);
      }
      } finally {
        gate?.notifyReservationComplete(bookingId);
      }
    }

    if (succeeded === 0 && processed > 0) {
      await dualLogError(
        `Agoda UPC streaming: no card info saved for any of ${processed} booking(s)`,
        failed.join(", ") || undefined,
        { jobId }
      );
    } else if (processed > 0) {
      await dualLogInfo("Agoda UPC streaming finished", {
        jobId,
        processed,
        succeeded,
        failed: failed.length,
      });
    }

    return {
      bookingIdsRequested: processed,
      bookingIdsSucceeded: succeeded,
      bookingIdsFailed: failed,
    };
  } catch (e: unknown) {
    await dualLogError(
      "Agoda UPC streaming failed (non-fatal for property job)",
      e instanceof Error ? e.message : e,
      { jobId }
    );
    return {
      bookingIdsRequested: processed,
      bookingIdsSucceeded: succeeded,
      bookingIdsFailed: failed.length > 0 ? failed : [],
    };
  } finally {
    if (listPage) {
      try {
        await listPage.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Runs after all booking data is known: preloads all IDs into the streaming queue.
 * Prefer `runAgodaUpcPhaseStreaming` fed during `mapApiResponseToCsvRecords` for overlap with API.
 */
export async function runAgodaUpcPhase(
  browser: Browser,
  params: {
    jobId: string;
    agodaId: string;
    bookingIds: string[];
    agodaUsername?: string;
    /** Same MM/DD/YYYY (or YYYY-MM-DD) as property scrape */
    listStartDate: string;
    listEndDate: string;
  }
): Promise<AgodaUpcPhaseResult> {
  const ids = params.bookingIds.map((id) => String(id).trim()).filter(Boolean);
  if (ids.length === 0) {
    return {
      bookingIdsRequested: 0,
      bookingIdsSucceeded: 0,
      bookingIdsFailed: [],
    };
  }

  const queue = new ReservationIdQueue();
  for (const id of ids) {
    queue.enqueue(id);
  }
  queue.close();

  return runAgodaUpcPhaseStreaming(browser, {
    jobId: params.jobId,
    agodaId: params.agodaId,
    agodaUsername: params.agodaUsername,
    listStartDate: params.listStartDate,
    listEndDate: params.listEndDate,
    queue,
  });
}
