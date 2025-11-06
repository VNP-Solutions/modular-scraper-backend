import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";

/**
 * Check and fill invoice data in the table
 * This function validates and fills missing values in the invoice table
 */
export async function dbDatachecking(
  browser: Browser,
  page: Page,
  jobId?: string
): Promise<void> {
  try {
    await dualLogInfo("Starting DB data checking...");

    // Check if scraping is paused
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during DB data checking");
      throw new Error("Scraping was stopped during DB data checking");
    }

    // Get timeout configuration
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

    // Wait for the invoice table to load
    await dualLogInfo("Waiting for invoice table to load...");
    await page.waitForSelector("#invoice-details-table", {
      visible: true,
      timeout: loadingTimeout,
    });

    await delay(3000); // Give time for data to fully load

    await dualLogInfo("Invoice table loaded, checking data...");

    // Check the header checkbox to select all rows
    await dualLogInfo("Checking 'Select All' checkbox in header...");
    const headerCheckboxChecked = await page.evaluate(() => {
      const headerCheckbox = document.querySelector(
        "#checkUncheckAll"
      ) as HTMLInputElement;
      if (headerCheckbox) {
        if (!headerCheckbox.checked) {
          headerCheckbox.click();
        }
        return true;
      }
      return false;
    });

    if (!headerCheckboxChecked) {
      throw new Error("Could not find or check header checkbox");
    }

    await dualLogInfo("Header checkbox checked, all rows selected");
    await delay(1000);

    // Get all rows in the table
    const rows = await page.$$eval("#invoice-details-table tbody tr", (rows) =>
      rows.map((row, index) => ({
        index,
        hasData: true,
      }))
    );

    await dualLogInfo(`Found ${rows.length} row(s) in invoice table`);

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      await dualLogInfo(`Processing row ${i}...`);

      // Check pause state before processing each row
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError("Scraping was stopped during row processing");
        throw new Error("Scraping was stopped during row processing");
      }

      // Get row data
      const rowData = await page.evaluate((rowIndex) => {
        const row = document.querySelectorAll(
          "#invoice-details-table tbody tr"
        )[rowIndex];
        if (!row) return null;

        // Get Requested Booking Amount input
        const bookingAmountInput = row.querySelector(
          `input.bookingAmount`
        ) as HTMLInputElement;
        const bookingAmountValue = bookingAmountInput
          ? bookingAmountInput.value.trim()
          : "";

        // Get Requested Taxes input
        const taxAmountInput = row.querySelector(
          `input.taxAmount`
        ) as HTMLInputElement;
        const taxAmountValue = taxAmountInput
          ? taxAmountInput.value.trim()
          : "";

        // Get Max. Billable Amount
        const billableAmountTd = row.querySelector(
          `td[data-title="Max. Billable Amount"]`
        );
        const billableAmountText = billableAmountTd
          ? billableAmountTd.textContent?.trim() || ""
          : "";
        // Extract numeric value (e.g., "USD 0.03" -> "0.03")
        const billableAmountMatch = billableAmountText.match(/[\d.]+/);
        const billableAmount = billableAmountMatch
          ? billableAmountMatch[0]
          : "";

        return {
          bookingAmountValue,
          taxAmountValue,
          billableAmount,
          bookingAmountInputId: bookingAmountInput?.id || "",
          taxAmountInputId: taxAmountInput?.id || "",
        };
      }, i);

      if (!rowData) {
        await dualLogError(`Could not get data for row ${i}`);
        continue;
      }

      await dualLogInfo(`Row ${i} data:`, rowData);

      // Check if Requested Booking Amount has a non-zero value
      const hasValidBookingAmount =
        rowData.bookingAmountValue &&
        rowData.bookingAmountValue !== "0.00" &&
        rowData.bookingAmountValue !== "0" &&
        rowData.bookingAmountValue !== "";

      // Check if Requested Taxes has a non-zero value
      const hasValidTaxAmount =
        rowData.taxAmountValue &&
        rowData.taxAmountValue !== "0.00" &&
        rowData.taxAmountValue !== "0" &&
        rowData.taxAmountValue !== "";

      // If both have valid non-zero values, row is OK
      if (hasValidBookingAmount && hasValidTaxAmount) {
        await dualLogInfo(
          `Row ${i}: Both Requested Booking Amount (${rowData.bookingAmountValue}) and Requested Taxes (${rowData.taxAmountValue}) have valid values. Row is OK.`
        );
        continue;
      }

      // If Requested Booking Amount is zero or empty but Max. Billable Amount has value
      if (
        !hasValidBookingAmount &&
        rowData.billableAmount &&
        rowData.billableAmount !== "0.00" &&
        rowData.billableAmount !== "0"
      ) {
        await dualLogInfo(
          `Row ${i}: Requested Booking Amount is zero/empty (${rowData.bookingAmountValue}). Filling with Max. Billable Amount: ${rowData.billableAmount}`
        );

        try {
          // First, check the row checkbox to enable the inputs
          const checkboxId = `submitBooking-${i}`;
          await dualLogInfo(
            `Row ${i}: Clicking checkbox #${checkboxId} to enable inputs...`
          );

          await page.evaluate((cbId) => {
            const checkbox = document.querySelector(
              `#${cbId}`
            ) as HTMLInputElement;
            if (checkbox && !checkbox.checked) {
              checkbox.click();
            }
          }, checkboxId);

          await delay(500); // Wait for inputs to be enabled

          // Use attribute selector for IDs that start with numbers
          await dualLogInfo(
            `Row ${i}: Clicking and filling Requested Booking Amount...`
          );
          await page.evaluate(
            (inputId, value) => {
              const input = document.querySelector(
                `[id="${inputId}"]`
              ) as HTMLInputElement;
              if (input) {
                input.focus();
                input.select();
                input.value = value;
                // Trigger change event
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              }
            },
            rowData.bookingAmountInputId,
            rowData.billableAmount
          );

          await dualLogInfo(
            `Row ${i}: Typed ${rowData.billableAmount} into Requested Booking Amount`
          );

          // Wait for potential auto-fill of Requested Taxes
          await delay(2000);

          // Check if Requested Taxes auto-filled
          const taxAutoFilled = await page.evaluate((taxInputId) => {
            const taxInput = document.querySelector(
              `[id="${taxInputId}"]`
            ) as HTMLInputElement;
            if (taxInput) {
              const value = taxInput.value.trim();
              return value && value !== "0.00" && value !== "0" ? value : null;
            }
            return null;
          }, rowData.taxAmountInputId);

          if (taxAutoFilled) {
            await dualLogInfo(
              `Row ${i}: Requested Taxes auto-filled with value: ${taxAutoFilled}`
            );
          } else {
            await dualLogInfo(
              `Row ${i}: Requested Taxes did not auto-fill, keeping as 0.00`
            );
          }
        } catch (fillError) {
          await dualLogError(
            `Row ${i}: Error filling Requested Booking Amount:`,
            fillError
          );
          // Continue to next row even if this one fails
        }
      } else if (hasValidBookingAmount) {
        await dualLogInfo(
          `Row ${i}: Requested Booking Amount has value (${rowData.bookingAmountValue}), row is OK`
        );
      } else {
        await dualLogInfo(
          `Row ${i}: Both Requested Booking Amount and Max. Billable Amount are zero or empty, skipping`
        );
      }

      await delay(500);
    }

    await dualLogInfo("DB data checking completed successfully!");
  } catch (error: any) {
    await dualLogError("Error in dbDatachecking:", error);
    throw error;
  }
}
