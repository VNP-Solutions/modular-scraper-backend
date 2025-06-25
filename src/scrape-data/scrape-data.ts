import { Page } from "puppeteer";
import { delay } from "../common/delay.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { CardInfo, PaymentInfo } from "../models/job-item.model.js";
import { CreateJobItemData, jobService } from "../services/job.service.js";

const pageReservations: any[] = [];
const processedReservationIds = new Set();

export async function scrapeData(
  page: Page,
  expediaId: string = "",
  start_date: string = "",
  end_date: string = "",
  jobId?: string
) {
  try {
    await dualLogInfo(
      `Starting scrapeData with jobId: ${jobId}, expediaId: ${expediaId}`,
      { jobId, expediaId, start_date, end_date }
    );

    // Get property_id from job for database storage
    let propertyIdForDb: string | null = null;
    if (jobId) {
      try {
        const job = await jobService.getJobById(jobId);
        if (job && job.property_id) {
          propertyIdForDb = job.property_id.toString();
          await dualLogInfo(
            `Using property_id: ${propertyIdForDb} for database storage`,
            { propertyIdForDb, jobId }
          );
        } else {
          await dualLogWarn(
            `Could not get property_id from job ${jobId}, will skip database storage`,
            { jobId }
          );
        }
      } catch (error) {
        await dualLogError(
          `Error getting property_id from job ${jobId}:`,
          error,
          { jobId }
        );
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
          timeout: 30000,
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
              if (jobId && propertyIdForDb) {
                await saveReservationToDatabase(
                  jobId,
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
                      timeout: 8000,
                    }),
                    new Promise((_, reject) =>
                      setTimeout(
                        () => reject(new Error("Dialog timeout")),
                        8000
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
                  if (jobId && propertyIdForDb) {
                    await saveReservationToDatabase(
                      jobId,
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
                          timeout: 30000,
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

                    // Extract "Remaining amount to charge" and "Amount to refund"
                    const additionalPaymentInfo = await page.evaluate(() => {
                      // Find "Remaining amount to charge"
                      const remainingAmountSection = Array.from(
                        document.querySelectorAll(".fds-cell.sidePanelSection")
                      ).find((section) =>
                        section.textContent?.includes(
                          "Remaining amount to charge"
                        )
                      );

                      const remainingAmount =
                        remainingAmountSection
                          ?.querySelector(".fds-currency-value")
                          ?.textContent?.trim() || "";

                      // Find "Amount to refund"
                      const refundSection = Array.from(
                        document.querySelectorAll(".fds-grid.sidePanelSection")
                      ).find((section) =>
                        section.textContent?.includes("Amount to refund")
                      );

                      const refundAmount =
                        refundSection
                          ?.querySelector(".fds-currency-value")
                          ?.textContent?.trim() || "";

                      return {
                        remainingAmountToCharge: remainingAmount,
                        amountToRefund: refundAmount,
                      };
                    });

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
                        if (remainingBalance) {
                          paymentData.amount_to_charge_or_refund =
                            parsePaymentAmount(remainingBalance);
                        } else if (remainingBalance) {
                          paymentData.amount_to_charge_or_refund =
                            -parsePaymentAmount(remainingBalance); // Negative for refund
                        }
                      } else if (remainingBalance) {
                        // Create payment data if we have charge/refund info but no other payment data
                        paymentData = {
                          total_guest_payment: 0,
                          cancellation_fee: 0,
                          total_payout: 0,
                          amount_to_charge_or_refund:
                            parsePaymentAmount(remainingBalance),
                        };
                      }

                      // Update card data with reason_for_charge (moved from payment data)
                      if (cardData) {
                        if (remainingAmountToCharge) {
                          cardData.reason_for_charge =
                            hasEvcCard.status || "Charged In Full";
                        } else if (amountToRefund) {
                          cardData.reason_for_charge =
                            hasEvcCard.status || "Amount to refund";
                        }
                      } else if (
                        (remainingAmountToCharge || amountToRefund) &&
                        !cardData
                      ) {
                        // Create basic card data with reason if we have charge/refund info but no card data
                        cardData = {
                          card_number: "N/A",
                          expiry_date: "N/A",
                          reason_for_charge: hasEvcCard.status || "None",
                        };
                      }

                      if (remainingAmountToCharge) {
                        await dualLogInfo(
                          `Found Remaining amount to charge: ${remainingAmountToCharge}`,
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
                if (jobId && propertyIdForDb) {
                  await saveReservationToDatabase(
                    jobId,
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
                  if (jobId && propertyIdForDb) {
                    await saveReservationToDatabase(
                      jobId,
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
            if (jobId && propertyIdForDb && basicData?.reservationId) {
              await saveReservationToDatabase(
                jobId,
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
  } catch (error) {
    await dualLogError("Error in scrapeData:", error, { jobId });
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
    // Validate jobId before processing
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

    // Check if jobId looks like a valid ObjectId (24 character hex string)
    if (!/^[0-9a-fA-F]{24}$/.test(jobId)) {
      throw new Error(
        `Invalid jobId format: ${jobId}. JobId must be a 24 character hexadecimal string (MongoDB ObjectId).`
      );
    }

    // propertyId should also be a valid ObjectId since it comes from the job's property_id
    if (!/^[0-9a-fA-F]{24}$/.test(propertyId)) {
      throw new Error(
        `Invalid propertyId format: ${propertyId}. PropertyId must be a 24 character hexadecimal string (MongoDB ObjectId).`
      );
    }

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

    const jobItemData: CreateJobItemData = {
      job_id: jobId,
      property_id: propertyId, // Now an ObjectId string from the job
      guest_name: basicData.guestName || "Unknown Guest",
      reservation_id: basicData.reservationId,
      confirmation_number: basicData.confirmationCode || "",
      check_in_date: parseDate(basicData.checkInDate),
      check_out_date: parseDate(basicData.checkOutDate),
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

    const savedItem = await jobService.createJobItem(jobItemData);
    await dualLogInfo(
      `✅ Saved reservation ${basicData.reservationId} to database`,
      { jobId }
    );
    return savedItem;
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
