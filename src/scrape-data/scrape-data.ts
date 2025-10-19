import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { CardInfo, PaymentInfo } from "../models/job-item.model.js";
import { CreateJobItemData, jobService } from "../services/job.service.js";
import {
  CreateRetrievalItemData,
  retrievalService,
} from "../services/retrieval.service.js";

const pageReservations: any[] = [];
const processedReservationIds = new Set();

// Global context for retrieval scraping
let currentRetrievalContext: {
  retrievalId: string;
  parentRetrievalId: string;
  jobId: string; // Add jobId to context
} | null = null;

export function setRetrievalContext(
  retrievalId: string,
  parentRetrievalId: string,
  jobId: string
) {
  currentRetrievalContext = { retrievalId, parentRetrievalId, jobId };
}

export function clearRetrievalContext() {
  currentRetrievalContext = null;
}

// Function to clear processed reservations for new job runs
export function clearProcessedReservations() {
  processedReservationIds.clear();
}

export async function scrapeData(
  browser: Browser,
  page: Page,
  expediaId: string = "",
  start_date: string = "",
  end_date: string = "",
  jobId?: string
) {
  try {
    // Use jobId from retrieval context if not provided
    const effectiveJobId = jobId || currentRetrievalContext?.jobId;

    await dualLogInfo(
      `Starting scrapeData with jobId: ${effectiveJobId}, expediaId: ${expediaId}`,
      {
        jobId: effectiveJobId,
        expediaId,
        start_date,
        end_date,
        hasRetrievalContext: !!currentRetrievalContext,
      }
    );

    // Get timeout configuration for this job
    const selectorTimeout = await timeoutManager.getSelectorTimeout(
      effectiveJobId
    );

    // Get property_id from job or retrieval for database storage
    let propertyIdForDb: string | null = null;
    if (effectiveJobId) {
      // If in retrieval context, get property_id from retrieval
      if (currentRetrievalContext) {
        try {
          const retrieval = await retrievalService.getRetrievalById(
            currentRetrievalContext.retrievalId
          );
          if (retrieval && retrieval.property_id) {
            propertyIdForDb = retrieval.property_id.toString();
            await dualLogInfo(
              `Using property_id from retrieval: ${propertyIdForDb} for database storage`,
              {
                propertyIdForDb,
                retrievalId: currentRetrievalContext.retrievalId,
              }
            );
          }
        } catch (error) {
          await dualLogError(
            `Error getting property_id from retrieval ${currentRetrievalContext.retrievalId}:`,
            error,
            { retrievalId: currentRetrievalContext.retrievalId }
          );
        }
      } else {
        // Standard job-based scraping
        try {
          const job = await jobService.getJobById(effectiveJobId);
          if (job && job.property_id) {
            propertyIdForDb = job.property_id.toString();
            await dualLogInfo(
              `Using property_id: ${propertyIdForDb} for database storage`,
              { propertyIdForDb, jobId: effectiveJobId }
            );
          } else {
            await dualLogWarn(
              `Could not get property_id from job ${effectiveJobId}, will skip database storage`,
              { jobId: effectiveJobId }
            );
          }
        } catch (error) {
          await dualLogError(
            `Error getting property_id from job ${effectiveJobId}:`,
            error,
            { jobId: effectiveJobId }
          );
        }
      }
    }

    // Function to get total results count
    const getTotalResults = async () => {
      const resultsText = await page.$eval(
        ".fds-pagination-showing-result",
        (el) => el.textContent || ""
      );
      const match = resultsText.match(/of (\d+) Results/);
      return match ? parseInt(match[1]) : 0;
    };

    // Function to check if there's a next page
    const hasNextPage = async () => {
      return await page.evaluate(() => {
        const nextButton = document.querySelector(
          ".fds-pagination-button.next button"
        ) as HTMLButtonElement;
        return nextButton && !nextButton.disabled;
      });
    };

    const totalResults = await getTotalResults();
    await dualLogInfo(`Total reservations to fetch: ${totalResults}`, {
      totalResults,
      jobId,
    });

    // Update progress with total count
    scrapingStateManager.updateProgress(undefined, undefined, 0, totalResults);

    let currentPage = 1;
    let hasMore = true;
    let processedCount = 0;

    while (hasMore) {
      try {
        // Check if scraping is paused and wait if needed
        await scrapingStateManager.waitWhilePaused();

        // Check if scraping was stopped while paused
        if (!scrapingStateManager.isRunning()) {
          await dualLogInfo("Scraping was stopped, exiting...", { jobId });
          break;
        }

        await dualLogInfo(`Processing page ${currentPage}...`, {
          currentPage,
          jobId,
        });

        // Update progress with current page
        scrapingStateManager.updateProgress(
          currentPage,
          undefined,
          processedCount,
          totalResults
        );

        // Wait for table data to load
        await page.waitForSelector("table.fds-data-table tbody tr", {
          visible: true,
          timeout: selectorTimeout,
        });
        await delay(5000);

        // Get reservations from current page
        const rows = await page.$$("table.fds-data-table tbody tr");

        for (const row of rows) {
          // Check if scraping is paused before processing each row
          await scrapingStateManager.waitWhilePaused();

          // Check if scraping was stopped while paused
          if (!scrapingStateManager.isRunning()) {
            await dualLogInfo("Scraping was stopped, exiting...", { jobId });
            return;
          }

          let basicData: any = null;
          let cardData: CardInfo | null = null;
          let paymentData: PaymentInfo | null = null;
          let remainingAmountToCharge = null;
          let amountToRefund = null;
          let status = "Active"; // Default status
          let remainingBalance = "N/A";

          try {
            // Get basic data first
            basicData = await page.evaluate((row) => {
              return {
                guestName:
                  row
                    .querySelector(
                      "td.guestName button.guestNameLink span.fds-button2-label"
                    )
                    ?.textContent?.trim() || "",
                reservationId:
                  row
                    .querySelector("td.reservationId div.fds-cell")
                    ?.textContent?.trim() || "",
                confirmationCode:
                  row
                    .querySelector(
                      "td.confirmationCode label.confirmationCodeLabel"
                    )
                    ?.textContent?.trim() || "",
                checkInDate:
                  row.querySelector("td.checkInDate")?.textContent?.trim() ||
                  "",
                checkOutDate:
                  row.querySelector("td.checkOutDate")?.textContent?.trim() ||
                  "",
                roomType:
                  row.querySelector("td.roomType")?.textContent?.trim() || "",
                bookingAmount:
                  row
                    .querySelector("td.bookingAmount .fds-currency-value")
                    ?.textContent?.trim() || "",
                bookedDate:
                  row.querySelector("td.bookedOnDate")?.textContent?.trim() ||
                  "",
                reservationStatus:
                  row
                    .querySelector("td.bookingAmount .secondRowStyle span")
                    ?.textContent?.trim() || "",
              };
            }, row);

            // Skip if no reservation ID
            if (!basicData.reservationId) {
              await dualLogInfo("No reservation ID found, skipping...", {
                jobId,
              });
              continue;
            }

            // Check if we've already processed this reservation in memory
            if (processedReservationIds.has(basicData.reservationId)) {
              await dualLogInfo(
                `Skipping duplicate reservation in memory: ${basicData.reservationId}`,
                { jobId }
              );
              continue;
            }

            // Check if reservation already exists in database (only if we have valid database info)
            if (
              jobId &&
              propertyIdForDb &&
              (await jobService.reservationExists(
                jobId,
                basicData.reservationId
              ))
            ) {
              await dualLogInfo(
                `Skipping duplicate reservation in database: ${basicData.reservationId}`,
                { jobId }
              );
              processedReservationIds.add(basicData.reservationId);
              processedCount++;
              continue;
            }

            // Add to processed set
            processedReservationIds.add(basicData.reservationId);
            processedCount++;

            // Update progress count
            scrapingStateManager.updateProgress(
              currentPage,
              undefined,
              processedCount,
              totalResults
            );

            await dualLogInfo(
              `Processing reservation ${processedCount}/${totalResults}: ${basicData.reservationId}`,
              { jobId }
            );

            // Get card details
            const guestNameButton = await row.$(
              "td.guestName button.guestNameLink"
            );
            if (!guestNameButton) {
              await dualLogInfo(
                "Guest name button not found, skipping reservation",
                { jobId }
              );

              // Save basic data to database even without card info (only if we have valid database info)
              if (effectiveJobId && propertyIdForDb) {
                await saveReservationToDatabase(
                  effectiveJobId,
                  propertyIdForDb,
                  basicData,
                  null,
                  null
                );
              }
              continue;
            }

            for (let i = 0; i < 3; i++) {
              try {
                //dialog open kortesi
                try {
                  await guestNameButton.click();
                  await delay(1000);
                  await Promise.race([
                    page.waitForSelector(".fds-dialog", {
                      visible: true,
                      timeout: selectorTimeout,
                    }),
                    new Promise((_, reject) =>
                      setTimeout(
                        () => reject(new Error("Dialog timeout")),
                        selectorTimeout
                      )
                    ),
                  ]);
                  // Wait a bit for content to load
                  await delay(2000);
                } catch (error) {
                  await dualLogInfo(
                    "Dialog did not appear within timeout, skipping to next reservation",
                    { jobId }
                  );

                  // Save basic data to database even without detailed info (only if we have valid database info)
                  if (effectiveJobId && propertyIdForDb) {
                    await saveReservationToDatabase(
                      effectiveJobId,
                      propertyIdForDb,
                      basicData,
                      null,
                      null
                    );
                  }
                  continue;
                }

                // Scroll to the bottom of dialog content and wait
                await page.evaluate(() => {
                  const dialogContent = document.querySelector(
                    ".fds-dialog-content"
                  ) as HTMLElement;
                  if (dialogContent) {
                    dialogContent.scrollTo(0, dialogContent.scrollHeight);
                  }
                });

                // Wait for content to load after scroll
                await delay(2000);

                // Look for the "See card activity" button and click it in a new tab
                try {
                  const seeCardActivityButton = await page.$(
                    ".fds-cell.all-y-gutter-16 button.fds-button2.utility.small"
                  );

                  if (seeCardActivityButton) {
                    await dualLogInfo(
                      "Found 'See card activity' button, clicking it in a new tab...",
                      { jobId }
                    );

                    // Get href or onclick URL from the button
                    const buttonUrl = await page.evaluate(() => {
                      const button = document.querySelector(
                        ".fds-cell.all-y-gutter-16 button.fds-button2.utility.small"
                      ) as HTMLElement;
                      if (!button) return null;

                      // Click the button but prevent navigation by returning the URL
                      const originalOpen = window.open;
                      let capturedUrl: string | null = null;

                      // Override window.open temporarily to capture the URL
                      window.open = (url?: string | URL) => {
                        capturedUrl = url?.toString() || null;
                        return { focus: () => {} } as any; // Mock window object
                      };

                      // Simulate click to trigger any onclick handlers
                      button.click();

                      // Restore original window.open
                      window.open = originalOpen;

                      return capturedUrl;
                    });

                    if (buttonUrl) {
                      await dualLogInfo(
                        `Opening card activity URL in new tab: ${buttonUrl}`,
                        { jobId }
                      );

                      // Get browser from page
                      const browser = page.browser();
                      let newPage: Page | null = null;
                      try {
                        // Create a new page/tab
                        newPage = await browser.newPage();
                        await newPage.goto(buttonUrl, {
                          waitUntil: "networkidle0",
                          timeout: selectorTimeout,
                        });

                        await dualLogInfo("New tab opened for card activity", {
                          jobId,
                        });
                        await delay(5000); // Give more time for the page to fully load

                        // Scrape the remaining balance
                        remainingBalance = await newPage.evaluate(() => {
                          // Try multiple selectors to find the remaining balance
                          const selectors = [
                            ".evc-mock-card-remaining-balance .fds-currency-value",
                            ".remaining-balance .fds-currency-value",
                            '[class*="remaining-balance"] .fds-currency-value',
                            '[class*="balance"] .fds-currency-value',
                            ".fds-currency-value",
                          ];

                          for (const selector of selectors) {
                            const elements =
                              document.querySelectorAll(selector);
                            for (const element of elements) {
                              // Check if parent contains text about balance
                              const parent = element.closest("div");
                              if (
                                parent &&
                                parent.textContent
                                  ?.toLowerCase()
                                  .includes("balance")
                              ) {
                                return element.textContent?.trim() || "";
                              }
                            }
                          }

                          // If we couldn't find a specific balance element, try to get any currency value
                          const anyBalance = document.querySelector(
                            ".fds-currency-value"
                          );
                          return anyBalance
                            ? anyBalance.textContent?.trim() || "N/A"
                            : "N/A";
                        });

                        await dualLogInfo(
                          `Scraped remaining balance: ${remainingBalance}`,
                          { jobId }
                        );

                        // Take screenshot for debugging if needed
                        // await newPage.screenshot({ path: "card-activity.png" });

                        // Close the new tab
                        if (newPage) {
                          await newPage.close();
                        }
                      } catch (error: any) {
                        if (newPage) {
                          await newPage.close();
                        }
                        await dualLogError(
                          "got error on see card activity tab",
                          error.message,
                          { jobId }
                        );
                      }
                      await dualLogInfo("Closed card activity tab", { jobId });
                    } else {
                      await dualLogInfo(
                        "Could not capture URL from 'See card activity' button, skipping",
                        { jobId }
                      );
                    }
                  } else {
                    await dualLogInfo(
                      "'See card activity' button not found, skipping",
                      { jobId }
                    );
                  }
                } catch (error: any) {
                  await dualLogError(
                    `Error processing card activity: ${error.message}`,
                    { jobId }
                  );
                }

                let additionalText = ""; // New variable to store additional text
                let retries = 0;
                while (retries < 3) {
                  try {
                    // First check for evcCardBase element
                    const hasEvcCard = await page.evaluate(() => {
                      const evcCardBase =
                        document.querySelector(".evcCardBase");
                      if (evcCardBase) {
                        // Get status badge if it exists
                        const statusBadge = evcCardBase.querySelector(
                          ".fds-grid.statusBadge .fds-badge"
                        );
                        return {
                          exists: true,
                          status: statusBadge
                            ? statusBadge.textContent?.trim() || "None"
                            : "None",
                        };
                      }
                      return { exists: false, status: "None" };
                    });

                    if (hasEvcCard.exists) {
                      status = hasEvcCard.status || "None";
                      // Get card details from evcCardBase
                      const rawCardData = await page.evaluate(
                        (currentStatus) => {
                          const cardNumber =
                            document
                              .querySelector(
                                ".evcCardBase .cardNumber.replay-conceal bdi"
                              )
                              ?.textContent?.trim() || "";
                          const expiryDate =
                            document
                              .querySelector(
                                ".evcCardBase .cardDetails .fds-cell.all-cell-1-4.fds-type-color-primary.replay-conceal"
                              )
                              ?.textContent?.trim() || "";
                          const cvv =
                            document
                              .querySelectorAll(
                                ".evcCardBase .cardDetails .fds-cell.all-cell-1-4.fds-type-color-primary.replay-conceal"
                              )[1]
                              ?.textContent?.trim() || "";

                          // Get additional text information
                          const additionalTextElements = Array.from(
                            document.querySelectorAll(
                              ".fds-cell.all-y-gutter-12 div, .fds-cell.sidePanelSection, .fds-cell.fds-type-color-attention.fds-grid .fds-cell.all-cell-fill"
                            )
                          );
                          const additionalText = additionalTextElements
                            .map((el) => el.textContent?.trim() || "")
                            .filter(
                              (text) =>
                                text &&
                                !text.includes("See card activity") &&
                                !text.includes("contact us") &&
                                !text.includes("Show contact details")
                            )
                            .join(" | ");

                          if (cardNumber) {
                            return {
                              cardNumber,
                              expiryDate,
                              cvv,
                              status: currentStatus,
                              additionalText,
                            };
                          }
                          return null;
                        },
                        status
                      );

                      // Map to CardInfo interface
                      if (rawCardData) {
                        cardData = {
                          card_number: rawCardData.cardNumber,
                          expiry_date: rawCardData.expiryDate,
                          cvv: rawCardData.cvv,
                          reason_for_charge: hasEvcCard.status || "None",
                        };
                        basicData.additional_text = rawCardData.additionalText;
                      }
                    }

                    // Always try to get payment information regardless of card data
                    const rawPaymentData = await page.evaluate(() => {
                      // Find all payment summary sections
                      const paymentSummary =
                        document.querySelector(".fds-card-content");
                      if (!paymentSummary) return null;

                      // Helper function to find value by section title
                      const findValueByTitle = (titleText: string) => {
                        const sections = Array.from(
                          paymentSummary.querySelectorAll(".fds-grid")
                        );
                        for (const section of sections) {
                          const title = section.querySelector(
                            ".sidePanelSectionTitle"
                          );
                          if (
                            title &&
                            title.textContent?.trim() === titleText
                          ) {
                            const value = section.querySelector(
                              ".fds-currency-value"
                            );
                            return value ? value.textContent?.trim() || "" : "";
                          }
                        }
                        return "";
                      };

                      // Get all payment values
                      const cancellationFee =
                        findValueByTitle("Cancellation fee");
                      const expediaCompensation = findValueByTitle(
                        "Expedia compensation"
                      );
                      const totalPayout = findValueByTitle("Your total payout");
                      const totalGuestPayment = findValueByTitle(
                        "Total guest payment"
                      );

                      if (
                        cancellationFee ||
                        expediaCompensation ||
                        totalPayout
                      ) {
                        return {
                          totalGuestPayment,
                          cancellationFee,
                          totalPayout,
                        };
                      }
                      return null;
                    });

                    // Map to PaymentInfo interface
                    if (rawPaymentData) {
                      // Parse string amounts to numbers
                      const parsePaymentAmount = (
                        amountStr: string
                      ): number => {
                        if (!amountStr) return 0;
                        const cleaned = amountStr.replace(/[^\d.-]/g, "");
                        const amount = parseFloat(cleaned);
                        return isNaN(amount) ? 0 : amount;
                      };

                      paymentData = {
                        total_guest_payment: parsePaymentAmount(
                          rawPaymentData.totalGuestPayment
                        ),
                        cancellation_fee: parsePaymentAmount(
                          rawPaymentData.cancellationFee
                        ),
                        total_payout: parsePaymentAmount(
                          rawPaymentData.totalPayout
                        ),
                        amount_to_charge_or_refund: 0, // Will be updated below
                      };
                    }

                    // Extract "Amount to charge", "Remaining amount to charge" and "Amount to refund"
                    const additionalPaymentInfo = await page.evaluate(() => {
                      // First, try to find "Amount to charge" (priority) with improved selectors
                      // Based on the HTML structure: <div class="fds-cell sidePanelSection all-y-gutter-12">Amount to charge<div class="sidePanelSectionTitle...
                      const amountToChargeSection = Array.from(
                        document.querySelectorAll(
                          ".fds-cell.sidePanelSection, .sidePanelSection"
                        )
                      ).find(
                        (section) =>
                          section.textContent?.includes("Amount to charge") &&
                          !section.textContent?.includes("Remaining")
                      );

                      let amountToCharge = "";
                      if (amountToChargeSection) {
                        // Try multiple selectors to find the currency value
                        const currencyValue =
                          amountToChargeSection.querySelector(
                            ".fds-currency-value"
                          ) ||
                          amountToChargeSection.querySelector(
                            ".sidePanelSectionTitle .fds-currency-value"
                          ) ||
                          amountToChargeSection.querySelector(
                            ".fds-currency .fds-currency-value"
                          );

                        amountToCharge =
                          currencyValue?.textContent?.trim() || "";
                      }

                      // If "Amount to charge" not found, try "Remaining amount to charge"
                      let remainingAmount = "";
                      if (!amountToCharge) {
                        const remainingAmountSection = Array.from(
                          document.querySelectorAll(
                            ".fds-cell.sidePanelSection, .sidePanelSection"
                          )
                        ).find((section) =>
                          section.textContent?.includes(
                            "Remaining amount to charge"
                          )
                        );

                        if (remainingAmountSection) {
                          const currencyValue =
                            remainingAmountSection.querySelector(
                              ".fds-currency-value"
                            ) ||
                            remainingAmountSection.querySelector(
                              ".sidePanelSectionTitle .fds-currency-value"
                            ) ||
                            remainingAmountSection.querySelector(
                              ".fds-currency .fds-currency-value"
                            );

                          remainingAmount =
                            currencyValue?.textContent?.trim() || "";
                        }
                      }

                      // Find "Amount to refund"
                      const refundSection = Array.from(
                        document.querySelectorAll(
                          ".fds-cell.sidePanelSection, .sidePanelSection, .fds-grid.sidePanelSection"
                        )
                      ).find((section) =>
                        section.textContent?.includes("Amount to refund")
                      );

                      let refundAmount = "";
                      if (refundSection) {
                        const currencyValue =
                          refundSection.querySelector(".fds-currency-value") ||
                          refundSection.querySelector(
                            ".sidePanelSectionTitle .fds-currency-value"
                          ) ||
                          refundSection.querySelector(
                            ".fds-currency .fds-currency-value"
                          );

                        refundAmount = currencyValue?.textContent?.trim() || "";
                      }

                      return {
                        amountToCharge: amountToCharge,
                        remainingAmountToCharge: remainingAmount,
                        amountToRefund: refundAmount,
                      };
                    });

                    // Log what we found in the sidebar
                    if (additionalPaymentInfo.amountToCharge) {
                      await dualLogInfo(
                        `Found "Amount to charge" in sidebar: ${additionalPaymentInfo.amountToCharge}`,
                        { jobId }
                      );
                    } else if (additionalPaymentInfo.remainingAmountToCharge) {
                      await dualLogInfo(
                        `Found "Remaining amount to charge" in sidebar: ${additionalPaymentInfo.remainingAmountToCharge}`,
                        { jobId }
                      );
                    } else {
                      await dualLogInfo(
                        "No amount to charge found in sidebar, will check 'See card activity' button",
                        { jobId }
                      );
                    }

                    // Check if we found "Amount to charge" in sidebar, if not, click "See card activity"
                    let finalAmountToCharge =
                      additionalPaymentInfo.amountToCharge ||
                      additionalPaymentInfo.remainingAmountToCharge;

                    // If no amount to charge found in sidebar, click "See card activity" button
                    if (!finalAmountToCharge) {
                      await dualLogInfo(
                        "Amount to charge not found in sidebar, looking for 'See card activity' button",
                        { jobId }
                      );

                      try {
                        // Try to find "See card activity" button using multiple approaches
                        const seeCardActivityButton =
                          (await page
                            .$$("button.fds-button2.utility.small")
                            .then(async (buttons) => {
                              for (const button of buttons) {
                                const text = await button.evaluate(
                                  (el) => el.textContent
                                );
                                if (text?.includes("See card activity")) {
                                  return button;
                                }
                              }
                              return null;
                            })) ||
                          (await page.$(
                            ".fds-cell.all-y-gutter-16 button.fds-button2.utility.small"
                          ));

                        if (seeCardActivityButton) {
                          await dualLogInfo(
                            "Found 'See card activity' button, clicking it to get amount to charge...",
                            { jobId }
                          );

                          // Get href or onclick URL from the button
                          const buttonUrl = await page.evaluate(() => {
                            const button = document.querySelector(
                              ".fds-cell.all-y-gutter-16 button.fds-button2.utility.small"
                            ) as HTMLElement;
                            if (!button) return null;

                            // Click the button but prevent navigation by returning the URL
                            const originalOpen = window.open;
                            let capturedUrl: string | null = null;

                            // Override window.open temporarily to capture the URL
                            window.open = (url?: string | URL) => {
                              capturedUrl = url?.toString() || null;
                              return { focus: () => {} } as any; // Mock window object
                            };

                            // Simulate click to trigger any onclick handlers
                            button.click();

                            // Restore original window.open
                            window.open = originalOpen;

                            return capturedUrl;
                          });

                          if (buttonUrl) {
                            // Get browser from page
                            const browser = page.browser();
                            let newPage: Page | null = null;
                            try {
                              // Create a new page/tab
                              newPage = await browser.newPage();
                              await newPage.goto(buttonUrl, {
                                waitUntil: "networkidle0",
                                timeout: 30000,
                              });

                              await delay(3000); // Give time for the page to fully load

                              // Extract amount to charge from card activity page
                              finalAmountToCharge = await newPage.evaluate(
                                () => {
                                  // Try multiple selectors to find the amount to charge
                                  const selectors = [
                                    ".fds-currency-value",
                                    "[class*='amount'] .fds-currency-value",
                                    "[class*='charge'] .fds-currency-value",
                                    ".evc-mock-card-remaining-balance .fds-currency-value",
                                  ];

                                  for (const selector of selectors) {
                                    const elements =
                                      document.querySelectorAll(selector);
                                    for (const element of elements) {
                                      const parent = element.closest("div");
                                      if (
                                        parent &&
                                        (parent.textContent
                                          ?.toLowerCase()
                                          .includes("amount to charge") ||
                                          parent.textContent
                                            ?.toLowerCase()
                                            .includes("charge") ||
                                          parent.textContent
                                            ?.toLowerCase()
                                            .includes("balance"))
                                      ) {
                                        return (
                                          element.textContent?.trim() || ""
                                        );
                                      }
                                    }
                                  }

                                  // If specific amount not found, try to get any currency value
                                  const anyAmount = document.querySelector(
                                    ".fds-currency-value"
                                  );
                                  return anyAmount
                                    ? anyAmount.textContent?.trim() || ""
                                    : "";
                                }
                              );

                              await dualLogInfo(
                                `Extracted amount to charge from card activity: ${finalAmountToCharge}`,
                                { jobId }
                              );

                              // Close the new tab
                              if (newPage) {
                                await newPage.close();
                              }
                            } catch (error: any) {
                              if (newPage) {
                                await newPage.close();
                              }
                              await dualLogError(
                                "Error accessing card activity page",
                                error.message,
                                { jobId }
                              );
                            }
                          }
                        } else {
                          await dualLogInfo(
                            "'See card activity' button not found",
                            { jobId }
                          );
                        }
                      } catch (error: any) {
                        await dualLogError(
                          `Error processing card activity for amount to charge: ${error.message}`,
                          { jobId }
                        );
                      }
                    }

                    // Update payment data and card data with additional info
                    if (additionalPaymentInfo) {
                      remainingAmountToCharge =
                        additionalPaymentInfo.remainingAmountToCharge;
                      amountToRefund = additionalPaymentInfo.amountToRefund;

                      // Parse amounts for payment data
                      const parsePaymentAmount = (
                        amountStr: string
                      ): number => {
                        if (!amountStr) return 0;
                        const cleaned = amountStr.replace(/[^\d.-]/g, "");
                        const amount = parseFloat(cleaned);
                        return isNaN(amount) ? 0 : amount;
                      };

                      // Update payment data if it exists, or create it
                      if (paymentData) {
                        if (finalAmountToCharge) {
                          paymentData.amount_to_charge_or_refund =
                            parsePaymentAmount(finalAmountToCharge);
                        } else if (amountToRefund) {
                          paymentData.amount_to_charge_or_refund =
                            -parsePaymentAmount(amountToRefund); // Negative for refund
                        }
                      } else if (finalAmountToCharge || amountToRefund) {
                        // Create payment data if we have charge/refund info but no other payment data
                        paymentData = {
                          total_guest_payment: 0,
                          cancellation_fee: 0,
                          total_payout: 0,
                          amount_to_charge_or_refund: finalAmountToCharge
                            ? parsePaymentAmount(finalAmountToCharge)
                            : -parsePaymentAmount(amountToRefund || "0"),
                        };
                      }

                      // Update card data with reason_for_charge (moved from payment data)
                      if (cardData) {
                        if (finalAmountToCharge) {
                          cardData.reason_for_charge =
                            hasEvcCard.status || "Charged In Full";
                        } else if (amountToRefund) {
                          cardData.reason_for_charge =
                            hasEvcCard.status || "Amount to refund";
                        }
                      } else if (
                        (finalAmountToCharge || amountToRefund) &&
                        !cardData
                      ) {
                        // Create basic card data with reason if we have charge/refund info but no card data
                        cardData = {
                          card_number: "N/A",
                          expiry_date: "N/A",
                          reason_for_charge: hasEvcCard.status || "None",
                        };
                      }

                      // Log the final amounts that will be used
                      if (finalAmountToCharge) {
                        await dualLogInfo(
                          `Final amount to charge: ${finalAmountToCharge}`,
                          { jobId }
                        );
                      }

                      if (amountToRefund) {
                        await dualLogInfo(
                          `Found Amount to refund: ${amountToRefund}`,
                          { jobId }
                        );
                      }
                    }

                    // Break the loop if we got either card data or payment data
                    if (cardData || paymentData) {
                      break;
                    }

                    retries++;
                    await delay(1000);
                  } catch (e) {
                    retries++;
                    await delay(1000);
                  }
                }

                //////////////////////////////////////////////////////////////
                //close the side panel
                //////////////////////////////////////////////////////////////
                try {
                  const closeButton = await page.$(
                    ".fds-dialog-header button.dialog-close"
                  );
                  if (closeButton) {
                    await closeButton.click();
                    await delay(1500);
                  }
                } catch (e) {
                  await dualLogInfo(
                    "Warning: Could not close dialog normally",
                    { jobId }
                  );
                }

                // Save the complete reservation data to database (only if we have valid database info)
                if (effectiveJobId && propertyIdForDb) {
                  await saveReservationToDatabase(
                    effectiveJobId,
                    propertyIdForDb,
                    basicData,
                    cardData,
                    paymentData
                  );
                }

                break; // Exit retry loop on success
              } catch (retryError) {
                await dualLogError(
                  `Retry ${i + 1} failed for reservation ${
                    basicData.reservationId
                  }:`,
                  retryError,
                  { jobId }
                );
                if (i === 2) {
                  // On final retry failure, still save basic data (only if we have valid database info)
                  if (effectiveJobId && propertyIdForDb) {
                    await saveReservationToDatabase(
                      effectiveJobId,
                      propertyIdForDb,
                      basicData,
                      null,
                      null
                    );
                  }
                }
              }
            }
          } catch (error: any) {
            await dualLogError(
              `Error processing reservation: ${error.message}`,
              { jobId }
            );
            // Still save what we have to database (only if we have valid database info)
            if (effectiveJobId && propertyIdForDb && basicData?.reservationId) {
              await saveReservationToDatabase(
                effectiveJobId,
                propertyIdForDb,
                basicData,
                null,
                null
              );
            }
          }
        }

        // Check for next page
        hasMore = await hasNextPage();
        if (hasMore) {
          await dualLogInfo("Navigating to next page...", { jobId });
          await page.click(".fds-pagination-button.next button");
          await delay(3000);
          currentPage++;
        }
      } catch (pageError: any) {
        await dualLogError(`Error processing page ${currentPage}:`, pageError, {
          jobId,
        });
        hasMore = false;
      }
    }

    await dualLogInfo(
      `Scraping completed. Processed ${processedCount} reservations.`,
      { jobId }
    );

    // Clear processed reservations for next job run
    clearProcessedReservations();
    await dualLogInfo("Cleared processed reservations for next job run", {
      jobId,
    });
  } catch (error) {
    // Clear processed reservations even if there's an error
    clearProcessedReservations();
    await dualLogError("Error in scrapeData:", error, { jobId });
    // Close browser when done with this attempt
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
    throw error;
  }
}

// Helper function to save reservation data to database
async function saveReservationToDatabase(
  jobId: string,
  propertyId: string,
  basicData: any,
  cardData: CardInfo | null,
  paymentData: PaymentInfo | null
) {
  try {
    // Validate inputs
    if (!jobId || typeof jobId !== "string") {
      throw new Error(
        `Invalid jobId: ${jobId}. JobId must be a non-empty string.`
      );
    }

    if (!propertyId || typeof propertyId !== "string") {
      throw new Error(
        `Invalid propertyId: ${propertyId}. PropertyId must be a non-empty string.`
      );
    }

    // propertyId should be a valid ObjectId
    if (!/^[0-9a-fA-F]{24}$/.test(propertyId)) {
      throw new Error(
        `Invalid propertyId format: ${propertyId}. PropertyId must be a 24 character hexadecimal string (MongoDB ObjectId).`
      );
    }

    // Check if jobId is a valid ObjectId (for regular job-based scraping)
    const isValidJobObjectId = /^[0-9a-fA-F]{24}$/.test(jobId);

    // Parse dates
    const parseDate = (dateStr: string): Date => {
      if (!dateStr) return new Date();

      // Handle different date formats that might come from scraping
      if (dateStr.includes("/")) {
        // Format: MM/DD/YYYY
        return new Date(dateStr);
      } else if (dateStr.includes("-")) {
        // Format: YYYY-MM-DD
        return new Date(dateStr);
      } else {
        // Try to parse as-is
        const parsed = new Date(dateStr);
        return isNaN(parsed.getTime()) ? new Date() : parsed;
      }
    };

    // Parse booking amount
    const parseAmount = (amountStr: string): number => {
      if (!amountStr) return 0;
      // Remove currency symbols and parse
      const cleaned = amountStr.replace(/[^\d.-]/g, "");
      const amount = parseFloat(cleaned);
      return isNaN(amount) ? 0 : amount;
    };

    // Save to JobItem only if jobId is a valid ObjectId (regular job-based scraping)
    if (isValidJobObjectId) {
      const jobItemData: CreateJobItemData = {
        job_id: jobId,
        property_id: propertyId,
        guest_name: basicData.guestName || "Unknown Guest",
        reservation_id: basicData.reservationId,
        confirmation_number: basicData.confirmationCode || "",
        check_in_date: basicData.checkInDate,
        check_out_date: basicData.checkOutDate,
        room_type: basicData.roomType || "Unknown",
        booking_amount: parseAmount(basicData.bookingAmount),
        booked_date: parseDate(basicData.bookedDate),
        has_card_info: !!cardData,
        card_info: cardData || undefined,
        has_payment_info: !!paymentData,
        payment_info: paymentData || undefined,
        reservation_status: basicData.reservationStatus,
        additional_text: basicData.additional_text || undefined,
      };

      // Save to JobItem (standard job-based scraping)
      await jobService.createJobItem(jobItemData);
      await dualLogInfo(
        `✅ Saved reservation ${basicData.reservationId} to JobItem database`,
        { jobId }
      );
    } else {
      await dualLogInfo(
        `Skipping JobItem save for non-job scraping (jobId: ${jobId})`,
        { jobId }
      );
    }

    // Also save to RetrievalItem if we're in a retrieval context
    if (currentRetrievalContext) {
      try {
        const retrievalItemData: CreateRetrievalItemData = {
          retrieval_id: currentRetrievalContext.retrievalId,
          parent_retrieval_id: currentRetrievalContext.parentRetrievalId,
          property_id: propertyId,
          guest_name: basicData.guestName || "Unknown Guest",
          reservation_id: basicData.reservationId,
          confirmation_number: basicData.confirmationCode || "",
          check_in_date: basicData.checkInDate,
          check_out_date: basicData.checkOutDate,
          room_type: basicData.roomType || "Unknown",
          booking_amount: parseAmount(basicData.bookingAmount),
          booked_date: parseDate(basicData.bookedDate),
          has_card_info: !!cardData,
          card_info: cardData || undefined,
          has_payment_info: !!paymentData,
          payment_info: paymentData || undefined,
          reservation_status: basicData.reservationStatus,
          additional_text: basicData.additional_text || undefined,
        };

        await retrievalService.createRetrievalItem(retrievalItemData);
        await dualLogInfo(
          `✅ Saved reservation ${basicData.reservationId} to RetrievalItem database`,
          { retrievalId: currentRetrievalContext.retrievalId }
        );
      } catch (retrievalError: any) {
        await dualLogError(
          `❌ Failed to save reservation ${basicData.reservationId} to RetrievalItem:`,
          retrievalError.message,
          { retrievalId: currentRetrievalContext.retrievalId }
        );
        // Don't throw - continue with scraping even if retrieval item save fails
      }
    }

    return true;
  } catch (dbError: any) {
    await dualLogError(
      `❌ Failed to save reservation ${
        basicData?.reservationId || "unknown"
      } to database:`,
      dbError.message,
      { jobId }
    );

    // Log additional context for debugging
    await dualLogError(
      `Debug info - jobId: ${jobId}, propertyId: ${propertyId}`,
      { jobId }
    );

    // Don't rethrow the error to prevent stopping the entire scraping process
    // Just log it and continue with the next reservation
    return null;
  }
}
