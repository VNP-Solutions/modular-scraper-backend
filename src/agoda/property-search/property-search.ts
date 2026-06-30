import { Browser, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { takeSuccessScreenshot } from "../../common/screenshot-helper.js";
import { timeoutManager } from "../../common/timeout-manager.js";

export interface AgodaPropertySearchResult {
  found: boolean;
  agodaId: string;
}

function convertDateFormat(dateString: string): string {
  let year: string, month: string, day: string;

  if (dateString.includes("/")) {
    const parts = dateString.split("/");
    month = parts[0].padStart(2, "0");
    day = parts[1].padStart(2, "0");
    year = parts[2];
  } else if (dateString.includes("-")) {
    const parts = dateString.split("-");
    year = parts[0];
    month = parts[1].padStart(2, "0");
    day = parts[2].padStart(2, "0");
  } else {
    throw new Error(`Unsupported date format: ${dateString}`);
  }

  return `${day}-${month}-${year}`;
}

/**
 * Navigates to the Agoda property booking page and checks whether the property
 * is accessible (Reservations section visible).
 */
export async function searchAgodaProperty(
  browser: Browser,
  page: Page,
  agodaId: string,
  startDate: string,
  endDate: string,
  jobId?: string
): Promise<AgodaPropertySearchResult> {
  let propertyPage: Page | undefined;

  try {
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during property search");
      throw new Error("Scraping was stopped during property search");
    }

    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const formattedStartDate = convertDateFormat(startDate);
    const formattedEndDate = convertDateFormat(endDate);

    const bookingUrl = `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}?startDate=${formattedStartDate}&endDate=${formattedEndDate}`;
    await dualLogInfo(`Navigating to property page: ${bookingUrl}`, {
      agodaId,
      jobId,
    });

    await delay(5000);

    propertyPage = await browser.newPage();

    let navigationAttempts = 0;
    const maxNavigationAttempts = 3;
    let propertyFound = false;

    while (navigationAttempts < maxNavigationAttempts && !propertyFound) {
      navigationAttempts++;

      await dualLogInfo(
        `Property search attempt ${navigationAttempts}/${maxNavigationAttempts}`,
        { agodaId, jobId }
      );

      await propertyPage.goto(bookingUrl, {
        waitUntil: "networkidle2",
        timeout: loadingTimeout,
      });

      await propertyPage.waitForSelector("body", { timeout: loadingTimeout });
      await delay(5000);

      try {
        let reservationsElement: unknown = null;

        const headings = await propertyPage.evaluate(() => {
          return Array.from(document.querySelectorAll("h2")).some(
            (h) => h.textContent?.trim() === "Reservations"
          );
        });

        if (headings) {
          reservationsElement = true;
        } else {
          const pageText = await propertyPage.evaluate(
            () => document.body.textContent || ""
          );
          if (pageText.includes("Reservations")) {
            reservationsElement = true;
          }
        }

        if (reservationsElement) {
          propertyFound = true;
          await dualLogInfo("Property found - Reservations section visible", {
            agodaId,
            jobId,
          });
          break;
        }

        await dualLogInfo(
          `Property not found on attempt ${navigationAttempts}`,
          { agodaId, jobId }
        );

        if (navigationAttempts < maxNavigationAttempts) {
          await delay(3000);
        }
      } catch (checkError: any) {
        await dualLogError(
          `Error checking property page on attempt ${navigationAttempts}:`,
          checkError.message,
          { agodaId, jobId }
        );

        if (navigationAttempts < maxNavigationAttempts) {
          await delay(3000);
        }
      }
    }

    if (propertyFound && jobId && propertyPage) {
      await takeSuccessScreenshot(propertyPage, jobId, "property_found");
    }

    return { found: propertyFound, agodaId };
  } catch (error: any) {
    await dualLogError("Error during Agoda property search:", error.message, {
      agodaId,
      jobId,
    });
    throw error;
  } finally {
    if (propertyPage) {
      try {
        await propertyPage.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
