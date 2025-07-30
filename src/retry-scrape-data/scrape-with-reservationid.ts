import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { retryScrape } from "./retry-scrape.js";

async function scrapeWithReservationId(browser: Browser, page: Page, reservation: any) {
  try {
    const reservationId = reservation.id;

    if (reservationId) {
      // Wait for property table to load
      await page.waitForSelector(".fds-data-table-wrapper", {
        visible: true,
        timeout: 30000,
      });

      // Wait for property search input
      await page.waitForSelector(
        ".all-properties__search input.fds-field-input"
      );

      // Get property ID from query params
      console.log(`Searching for property ID: ${reservationId}`);

      // Type property ID in search
      await page.type(
        ".all-properties__search input.fds-field-input",
        String(reservationId),
        { delay: 500 }
      );

      // Wait for search results
      await delay(2000);

      // Find and click the property link with more specific selector
      try {
        // Wait for search results to update
        await page.waitForSelector("tbody tr", {
          visible: true,
          timeout: 10000,
        });

        // Find and click the property link
        const clicked = await page.evaluate((searchId) => {
          const rows = Array.from(document.querySelectorAll("tbody tr"));
          for (const row of rows) {
            const idElement = row.querySelector(
              ".property-cell__property-id span"
            );
            if (
              idElement &&
              idElement.textContent &&
              idElement.textContent.includes(searchId)
            ) {
              const link = row.querySelector(
                ".property-cell__property-name a"
              ) as HTMLAnchorElement;
              if (link) {
                link.click();
                return true;
              }
            }
          }
          return false;
        }, String(reservationId));

        if (clicked) {
          console.log(`Found and clicked property with ID: ${reservationId}`);

          // Wait for navigation
          await Promise.all([
            page.waitForNavigation({
              waitUntil: "networkidle0",
              timeout: 30000,
            }),
            delay(8000),
          ]);

          console.log("Successfully navigated to property page");
        } else {
          throw new Error(`Could not find property with ID: ${reservationId}`);
        }
      } catch (error: any) {
        console.error(`Error finding/clicking property: ${error.message}`);
        throw error;
      }
    }

    console.log("Looking for Reservations link...");
    try {
      // Wait for the drawer content to load
      await page.waitForSelector(".uitk-drawer-content", {
        visible: true,
        timeout: 30000,
      });

      // Click using JavaScript with the exact structure
      const clicked = await page.evaluate(() => {
        const reservationsItem = Array.from(
          document.querySelectorAll(".uitk-action-list-item-content")
        ).find((item) => {
          const textDiv = item.querySelector(".uitk-text.overflow-wrap");
          return textDiv?.textContent?.trim() === "Reservations";
        });

        if (reservationsItem) {
          const link = reservationsItem.querySelector(
            "a.uitk-action-list-item-link"
          );
          if (link instanceof HTMLElement) {
            link.click();
            return true;
          }
        }
        return false;
      });

      if (!clicked) {
        throw new Error("Could not find or click Reservations link");
      }

      // Wait for navigation to complete
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle0",
          timeout: 80000,
        }),
        delay(8000),
      ]);

      console.log("Successfully navigated to Reservations page");

      // Wait for date filters to be visible
      console.log("Waiting for date filters...");
      await page.waitForSelector('input[type="radio"][name="dateTypeFilter"]', {
        visible: true,
        timeout: 80000,
      });

      // Get the current URL
      const currentUrl = page.url();
      console.log(`Current tab URL: ${currentUrl}`);

      if (reservation && reservation.idList) {
        for (const chunk of reservation.idList) {
          console.log(`Processing id: ${chunk}`);

          await retryScrape(browser, page, reservationId, chunk);
        }
      } else {
        console.error("Reservation or idList is undefined");
      }
      await delay(5000);
      try {
        // Wait for the header to be visible
        await page.waitForSelector("header.tpg-navigation__header", {
          visible: true,
          timeout: 5000,
        });

        // Try multiple approaches to click the logo
        const clicked = await page.evaluate(() => {
          // Try finding the logo link
          const logoLink = document.querySelector(
            "header.tpg-navigation__header a.tpg-navigation__logo_container"
          ) as HTMLElement;
          if (logoLink) {
            logoLink.click();
            return true;
          }
          return false;
        });

        if (!clicked) {
          // If direct click failed, try using the href
          const href = await page.evaluate(() => {
            const logoLink = document.querySelector(
              "header.tpg-navigation__header a.tpg-navigation__logo_container"
            ) as HTMLAnchorElement;
            return logoLink ? logoLink.href : null;
          });

          if (href) {
            await page.goto(href, { waitUntil: "networkidle0" });
          } else {
            throw new Error("Could not find navigation logo link");
          }
        }

        await delay(2000); // Wait for navigation
      } catch (error: any) {
        console.warn("Could not click navigation logo:", error.message);
        // Try alternative navigation
        try {
          await page.goto("https://apps.expediapartnercentral.com/", {
            waitUntil: "networkidle0",
          });
          await delay(2000);
        } catch (navError: any) {
          console.error("Failed to navigate to home page:", navError.message);
        }
      }

      // Add 5 second delay before processing next property
      console.log("Waiting 5 seconds before processing next property...");
      await delay(5000);
    } catch (error: any) {
      console.error("Error finding/clicking Reservations:", error.message);
      throw error;
    }
  } catch (error) {
    console.error("Error in scrapeWithReservationId:", error);
    throw error;
  }
}

export default scrapeWithReservationId;
