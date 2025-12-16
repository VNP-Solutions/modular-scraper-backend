import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { emailNotifier } from "../common/email-notifier.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { JobStatus } from "../models/job.model.js";
import { JobService } from "../services/job.service.js";

/**
 * Click on "Request payment from Expedia Group" in Quick tasks section
 * and set date range
 */
export async function clickExpediaPaymentandsetDaterange(
  browser: Browser,
  page: Page,
  startDate: string,
  endDate: string,
  jobId?: string
): Promise<void> {
  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during payment click");
      throw new Error("Scraping was stopped during payment click");
    }

    // Get timeout configuration for this job
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

    await dualLogInfo(
      "Looking for 'Request payment from Expedia Group' link..."
    );

    try {
      // Wait for the Quick tasks section to load
      await page.waitForSelector(".finance-quick-tasks-card", {
        visible: true,
        timeout: loadingTimeout,
      });

      await dualLogInfo("Quick tasks section found");

      // Click on "Request payment from Expedia Group" link
      const clicked = await page.evaluate(() => {
        const menuItems = Array.from(
          document.querySelectorAll(".fds-menulist-item")
        );

        for (const item of menuItems) {
          const link = item.querySelector("a.fds-menulist-item-label");
          if (
            link &&
            link.textContent?.trim() === "Request payment from Expedia Group"
          ) {
            if (link instanceof HTMLElement) {
              link.click();
              return true;
            }
          }
        }
        return false;
      });

      if (!clicked) {
        throw new Error(
          "Could not find or click 'Request payment from Expedia Group' link"
        );
      }

      await dualLogInfo(
        "Successfully clicked 'Request payment from Expedia Group'"
      );

      // Wait for navigation to complete
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle0",
          timeout: loadingTimeout,
        }),
        delay(5000),
      ]);

      //in here
      await dualLogInfo(
        "Successfully navigated to Request payment from Expedia Group page"
      );

      // Check for banking information modal
      await delay(3000);

      const bankingModalDetected = await page.evaluate(() => {
        const modal = document.querySelector("#paymentRequestInterceptModal");
        if (!modal) return false;

        // Check if modal has "active" class and contains the banking info message
        const isActive = modal.classList.contains("active");
        const modalTitle = modal.querySelector(
          "#paymentRequestInterceptModal-title"
        );
        const hasBankingTitle = modalTitle?.textContent?.includes(
          "We need your banking information"
        );

        return isActive && hasBankingTitle;
      });

      if (bankingModalDetected) {
        await dualLogWarn(
          "⚠️ BANKING INFORMATION MODAL DETECTED! Expedia requires banking information to be added."
        );
        await dualLogInfo("Sending email notifications...");

        // Get property info for the email
        let propertyName = "Unknown Property";
        let expediaId = "";

        if (jobId) {
          try {
            const jobService = new JobService();
            const job = await jobService.getJobById(jobId);
            if (job) {
              propertyName = job.property_name || propertyName;
            }

            // Get expedia_id from job's property
            const jobData = await jobService.getExpediaIdFromJob(jobId);
            if (jobData?.expediaId) {
              expediaId = jobData.expediaId;
            }
          } catch (error) {
            await dualLogWarn(
              "Could not fetch job/property details for email",
              { error }
            );
          }
        }

        // Send email notifications
        if (jobId) {
          try {
            await emailNotifier.notifyBankingInfoRequired(
              jobId,
              propertyName,
              expediaId
            );
            await dualLogInfo(
              "✅ Banking info notification emails sent successfully"
            );
          } catch (emailError) {
            await dualLogError(
              "Failed to send banking info emails:",
              emailError
            );
          }

          // Update job status to Failed
          try {
            const jobService = new JobService();
            await jobService.updateJobStatus(jobId, JobStatus.Failed);
            await dualLogInfo("✅ Job status updated to Failed");
          } catch (statusError) {
            await dualLogError("Failed to update job status:", statusError);
          }
        }

        // Throw error to stop the process (browser will be closed by parent function)
        await dualLogError(
          "❌ Job stopped due to missing banking information. Manual intervention required."
        );

        throw new Error(
          "BANKING_INFO_REQUIRED: Banking information required. Expedia is requesting banking details to be added before payment can be requested. Job has been marked as Failed and notification emails have been sent."
        );
      }

      await dualLogInfo(
        "✅ No banking information modal detected, proceeding..."
      );

      // Check if "Add more reservation IDs" link exists
      await delay(2000);

      const addMoreReservationExists = await page.evaluate(() => {
        const showSearchLink = document.querySelector("a.showSearch");
        return showSearchLink !== null;
      });

      if (addMoreReservationExists) {
        await dualLogInfo(
          "'Add more reservation IDs' link found, clicking it..."
        );

        // Click on "Add more reservation IDs" link
        const showSearchClicked = await page.evaluate(() => {
          const showSearchLink = document.querySelector("a.showSearch");
          if (showSearchLink && showSearchLink instanceof HTMLElement) {
            showSearchLink.click();
            return true;
          }
          return false;
        });

        if (showSearchClicked) {
          await dualLogInfo(
            "Clicked 'Add more reservation IDs', waiting for page update..."
          );
          await delay(3000);
        } else {
          await dualLogInfo(
            "Could not click 'Add more reservation IDs', proceeding anyway..."
          );
        }
      } else {
        await dualLogInfo(
          "'Add more reservation IDs' link not found, proceeding to date range tab..."
        );
      }

      // Click on "By Date Range" tab
      await dualLogInfo("Looking for 'By Date Range' tab...");

      const dateRangeTabClicked = await page.evaluate(() => {
        // Try to find the button by ID first
        const dateRangeButton = document.querySelector("#tab-dateRangeSearch");
        if (dateRangeButton && dateRangeButton instanceof HTMLElement) {
          dateRangeButton.click();
          return true;
        }

        // Fallback: find by text content
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const button of buttons) {
          const label = button.querySelector(".tab-label");
          if (label && label.textContent?.trim() === "By Date Range") {
            button.click();
            return true;
          }
        }
        return false;
      });

      if (!dateRangeTabClicked) {
        throw new Error("Could not find or click 'By Date Range' tab");
      }

      await dualLogInfo("Successfully clicked 'By Date Range' tab");
      await delay(2000);

      await dualLogInfo("Date range tab is ready for input");
    } catch (error) {
      await dualLogError("Error clicking payment link:", error);
      // Close browser when done with this attempt
      if (browser) {
        await browser.close();
      }
      await dualLogInfo("Browser closed successfully.");
      throw error;
    }
  } catch (error: any) {
    await dualLogError("Error in clickExpediaPaymentandsetDaterange:", error);
    throw error;
  }
}
