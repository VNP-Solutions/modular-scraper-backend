import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { dbDataService } from "../services/db-data.service.js";
import { dbEntryService } from "../services/db-entry.service.js";
import { dbDatachecking } from "./db-data-checking.js";
import { extractInvoiceRows } from "./extract-invoice-rows.js";

const BATCH_SIZE = 100;

/**
 * Switch to the "By Reservation ID" tab
 */
async function switchToReservationIdTab(page: Page): Promise<void> {
  await dualLogInfo("Switching to 'By Reservation ID' tab...");

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector(
      "#tab-reservationIdSearch"
    ) as HTMLElement | null;
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    throw new Error("Could not find or click 'By Reservation ID' tab");
  }

  await delay(2000);
  await dualLogInfo("Successfully switched to 'By Reservation ID' tab");
}

/**
 * Input a batch of reservation IDs into the tags-input field and click Add.
 * The page uses a tags-input widget: the visible input is inside
 * `.tags-input-wrapper` and the hidden backing input is `#reservationIdInput`.
 */
async function inputReservationIds(
  page: Page,
  ids: string[],
  batchNumber: number
): Promise<void> {
  await dualLogInfo(
    `Batch ${batchNumber}: Entering ${ids.length} reservation ID(s)...`
  );

  // Wait for the visible tags-input wrapper to be present & clear any old tags
  await page.waitForSelector(".tags-input-wrapper input", {
    visible: true,
    timeout: 15000,
  });

  // Clear existing tags / reset via JS
  await page.evaluate(() => {
    // Try to clear all existing tags if the control exposes a clear method
    const hiddenInput = document.querySelector(
      "#reservationIdInput"
    ) as HTMLInputElement | null;
    if (hiddenInput) {
      hiddenInput.value = "";
      hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Remove all existing tag spans/elements visually
    const wrapper = document.querySelector(".tags-input-wrapper");
    if (wrapper) {
      const tags = wrapper.querySelectorAll(
        ".tag, .badge, span[data-id], li.tag-item"
      );
      tags.forEach((t) => t.remove());
    }
  });

  await delay(500);

  // Type each ID followed by comma into the visible input to trigger tag creation
  const visibleInput = await page.$(".tags-input-wrapper input");
  if (!visibleInput) {
    throw new Error("Could not find tags-input visible input element");
  }

  // Use comma-separated string approach — type all IDs joined by comma then press Enter
  const idsString = ids.join(",");

  // Click to focus
  await visibleInput.click();
  await delay(300);

  // Type the comma-separated IDs
  await page.type(".tags-input-wrapper input", idsString, { delay: 5 });
  await delay(500);

  // Press Enter to confirm the tags
  await page.keyboard.press("Enter");
  await delay(500);

  // Also set the hidden backing input directly as a safety net
  await page.evaluate((idList: string) => {
    const hiddenInput = document.querySelector(
      "#reservationIdInput"
    ) as HTMLInputElement | null;
    if (hiddenInput) {
      hiddenInput.value = idList;
      hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
      hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Enable Add button
    const addBtn = document.querySelector(
      "#addButton"
    ) as HTMLButtonElement | null;
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.removeAttribute("disabled");
    }
  }, idsString);

  await delay(500);

  await dualLogInfo(
    `Batch ${batchNumber}: Reservation IDs entered, clicking Add button...`
  );

  // Click the Add button
  const addClicked = await page.evaluate(() => {
    const addBtn = document.querySelector("#addButton") as HTMLElement | null;
    if (addBtn) {
      addBtn.click();
      return true;
    }
    return false;
  });

  if (!addClicked) {
    throw new Error("Could not click #addButton");
  }

  await dualLogInfo(`Batch ${batchNumber}: Add button clicked`);
}

/**
 * Process all collected reservation IDs in batches of 100.
 * For each batch:
 *   1. Switch to "By Reservation ID" tab
 *   2. Enter IDs and click Add
 *   3. Wait for table, fill amounts
 *   4. Extract invoice rows
 *   5. Save to database
 */
export async function processReservationIds(
  browser: Browser,
  page: Page,
  reservationIds: string[],
  jobId?: string,
  expediaId?: string,
  propertyName?: string
): Promise<void> {
  if (reservationIds.length === 0) {
    await dualLogInfo(
      "No reservation IDs collected — skipping By Reservation ID phase"
    );
    return;
  }

  await dualLogInfo(
    `Starting By Reservation ID phase. Total IDs: ${reservationIds.length}, Batch size: ${BATCH_SIZE}`
  );

  // Chunk the IDs into batches of BATCH_SIZE
  const batches: string[][] = [];
  for (let i = 0; i < reservationIds.length; i += BATCH_SIZE) {
    batches.push(reservationIds.slice(i, i + BATCH_SIZE));
  }

  await dualLogInfo(`Total batches to process: ${batches.length}`);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batchNumber = batchIndex + 1;
    const batch = batches[batchIndex];

    // Check pause / stop state
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError(
        "Scraping was stopped during reservation ID batch processing"
      );
      throw new Error(
        "Scraping was stopped during reservation ID batch processing"
      );
    }

    await dualLogInfo(
      `\n--- Processing Batch ${batchNumber}/${batches.length} (${batch.length} IDs) ---`
    );
    await dualLogInfo(`IDs in this batch: ${batch.join(", ")}`);

    try {
      // Step 1: Switch to By Reservation ID tab
      await switchToReservationIdTab(page);

      // Step 2: Enter IDs and click Add
      await inputReservationIds(page, batch, batchNumber);

      // Step 3: Wait for the table to load
      await dualLogInfo(
        `Batch ${batchNumber}: Waiting for results to load...`
      );
      await delay(3000);

      // Wait for loading indicator to disappear
      try {
        await page
          .waitForSelector(".fds-loader.is-loading.is-visible", {
            visible: true,
            timeout: 5000,
          })
          .catch(() =>
            dualLogInfo(
              `Batch ${batchNumber}: No loading indicator found`
            )
          );

        await page
          .waitForSelector(".fds-loader.is-loading.is-visible", {
            hidden: true,
            timeout: 30000,
          })
          .catch(() =>
            dualLogInfo(
              `Batch ${batchNumber}: Loading indicator already hidden`
            )
          );
      } catch (loadErr) {
        await dualLogInfo(
          `Batch ${batchNumber}: Loading detection skipped`,
          loadErr
        );
      }

      await delay(3000);

      // Step 4: Check for "No results found" alert
      const noResultsVisible = await page.evaluate(() => {
        const alert = document.querySelector(
          "#noResultsAlert"
        ) as HTMLElement | null;
        if (!alert) return false;
        return alert.offsetParent !== null;
      });

      if (noResultsVisible) {
        await dualLogInfo(
          `Batch ${batchNumber}: No results found for these reservation IDs, skipping`
        );
        continue;
      }

      // Step 5: Fill amounts using the existing dbDatachecking logic
      await dualLogInfo(
        `Batch ${batchNumber}: Checking and filling invoice data...`
      );
      const hasData = await dbDatachecking(browser, page, jobId);

      if (!hasData) {
        await dualLogInfo(
          `Batch ${batchNumber}: No data found after dbDatachecking, skipping`
        );
        continue;
      }

      await dualLogInfo(
        `Batch ${batchNumber}: Data found and amounts filled`
      );

      // Step 6: Extract invoice rows
      let invoiceRows: any[] = [];
      try {
        await dualLogInfo(
          `Batch ${batchNumber}: Extracting invoice rows...`
        );
        invoiceRows = await extractInvoiceRows(page, jobId);
        await dualLogInfo(
          `Batch ${batchNumber}: Extracted ${invoiceRows.length} invoice row(s)`
        );
      } catch (extractErr) {
        await dualLogError(
          `Batch ${batchNumber}: Error extracting invoice rows:`,
          extractErr
        );
      }

      // Step 7: Extract total invoice amount
      let totalInvoiceAmount = 0;
      let totalInvoiceAmountCurrency: string | undefined = undefined;

      try {
        const extractedData = await page.evaluate(() => {
          const invoiceTotalElement = document.querySelector(".invoiceTotal");
          if (invoiceTotalElement) {
            const boldElement = invoiceTotalElement.querySelector("b");
            if (boldElement) {
              const text = boldElement.textContent || "";
              const currencyMatchStart = text.match(/^([A-Z]{3})\s/);
              const currencyMatchEnd = text.match(/\s([A-Z]{3})$/);
              const currency = currencyMatchStart
                ? currencyMatchStart[1]
                : currencyMatchEnd
                  ? currencyMatchEnd[1]
                  : undefined;
              const amountMatch = text.match(/-?[\d,]+\.?\d*/);
              let amount = 0;
              if (amountMatch) {
                const cleaned = amountMatch[0].replace(/,/g, "");
                const parsed = parseFloat(cleaned);
                amount = isNaN(parsed) ? 0 : parsed;
              }
              return { amount, currency };
            }
          }
          return { amount: 0, currency: undefined };
        });

        totalInvoiceAmount = extractedData.amount;
        totalInvoiceAmountCurrency = extractedData.currency;
        await dualLogInfo(
          `Batch ${batchNumber}: Total invoice amount: ${totalInvoiceAmount} ${totalInvoiceAmountCurrency || ""}`
        );
      } catch (amountErr) {
        await dualLogError(
          `Batch ${batchNumber}: Error extracting total invoice amount:`,
          amountErr
        );
      }

      // Step 8: Create Invoice — check disclaimer, submit, then capture gearbox queue IDs
      let gearboxQueueIds: string[] = [];
      await page.evaluate(() => {
        const cb = document.querySelector("#invoiceUploadDisclaimer") as HTMLInputElement;
        if (cb && !cb.checked) cb.click();
      });
      await delay(500);
      await page.click("#submitInvoice");
      await delay(3000);
      try {
        await page.waitForSelector("#success-alert", { timeout: 10000 });
        gearboxQueueIds = await page.evaluate(() => {
          const alert = document.querySelector("#success-alert");
          if (!alert) return [];
          const ids: string[] = [];
          alert.querySelectorAll("p").forEach((p) => {
            if (p.textContent?.includes("Gearbox Queue ID")) {
              p.querySelectorAll("b").forEach((b) => {
                const id = b.textContent?.trim();
                if (id) ids.push(id);
              });
            }
          });
          return ids;
        });
        await dualLogInfo(
          `Batch ${batchNumber}: Invoice submitted, gearbox queue ID(s): ${gearboxQueueIds.join(", ") || "(none)"}`
        );
      } catch (alertErr) {
        await dualLogError(`Batch ${batchNumber}: Could not get success alert:`, alertErr);
      }

      // Step 9: Save to database (db_data + db_entries with gearbox_queue_ids)
      if (jobId && expediaId) {
        try {
          await dualLogInfo(
            `Batch ${batchNumber}: Saving to database...`
          );

          const dbData = await dbDataService.createDbData({
            job_id: jobId,
            property_name: propertyName || "Unknown Property",
            property_id: expediaId,
            reservation_ids: batch,
            gearbox_queue_ids: gearboxQueueIds,
            total_invoice_amount: totalInvoiceAmount,
            total_invoice_amount_currency: totalInvoiceAmountCurrency,
          });
          const dbDataId = dbData._id.toString();
          await dualLogInfo(
            `Batch ${batchNumber}: db_data saved — ID: ${dbDataId}, gearbox_queue_ids: ${gearboxQueueIds.length}`
          );

          // Save invoice rows to db_entry with db_data_id and gearbox_queue_ids
          if (invoiceRows.length > 0) {
            try {
              const dbEntries = invoiceRows.map((row) => ({
                job_id: jobId,
                property_name: propertyName || "Unknown Property",
                property_id: expediaId,
                db_data_id: dbDataId,
                reservation_id: row.reservation_id,
                invoice_id: row.invoice_id,
                guest_name: row.guest_name,
                check_in_date: row.check_in_date,
                check_out_date: row.check_out_date,
                previously_paid_amount: row.previously_paid_amount,
                previously_paid_amount_currency:
                  row.previously_paid_amount_currency,
                maximum_billable_amount: row.maximum_billable_amount,
                maximum_billable_amount_currency:
                  row.maximum_billable_amount_currency,
                requested_booking_amount: row.requested_booking_amount,
                requested_taxes: row.requested_taxes,
                requested_total: row.requested_total,
                requested_total_currency: row.requested_total_currency,
                // Store the Gearbox Queue ID(s) from the invoice that covered this reservation
                gearbox_queue_ids: gearboxQueueIds,
              }));

              await dbEntryService.createDbEntries(dbEntries);
              await dualLogInfo(
                `Batch ${batchNumber}: Saved ${invoiceRows.length} row(s) to db_entry`
              );
            } catch (entryErr) {
              await dualLogError(
                `Batch ${batchNumber}: Error saving db_entry rows:`,
                entryErr
              );
            }
          }
        } catch (dbErr) {
          await dualLogError(
            `Batch ${batchNumber}: Error saving to database:`,
            dbErr
          );
          // Don't throw — continue with next batch
        }
      }

      await dualLogInfo(
        `Batch ${batchNumber}/${batches.length} completed successfully`
      );

      // Small pause between batches
      if (batchIndex < batches.length - 1) {
        await delay(2000);
      }
    } catch (batchErr) {
      await dualLogError(
        `Batch ${batchNumber}: Error processing batch:`,
        batchErr
      );
      throw batchErr;
    }
  }

  await dualLogInfo(
    `By Reservation ID phase complete. Processed ${batches.length} batch(es), ${reservationIds.length} total reservation ID(s).`
  );
}
