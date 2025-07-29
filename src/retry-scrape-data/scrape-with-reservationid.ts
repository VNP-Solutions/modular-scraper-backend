import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { emailNotifier } from "../common/email-notifier.js";
import { progressManager } from "../common/progress-manager.js";
import { retryScrape } from "./retry-scrape.js";

async function scrapeWithReservationId(browser: Browser, page: Page, reservation: any, jobId?: string) {
  try {
    const reservationId = reservation.id;

    if (reservationId) {
      // Wait for property table to load
      try {
        await page.waitForSelector(".fds-data-table-wrapper", {
          visible: true,
          timeout: 30000,
        });
      } catch (error: any) {
        console.error("Error waiting for property table:", error);
        
        // Send email notification for property table error
        if (jobId) {
          try {
            await emailNotifier.notifyJobError(
              jobId,
              `Failed to find property table for reservation ${reservationId}: ${error?.message || "Property table not found"}`,
              error,
              {
                stage: "scrape_with_reservation_property_table",
                progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
              }
            );
          } catch (emailError) {
            console.error("Failed to send property table error notification:", emailError);
          }
        }
        throw error;
      }

      // Wait for property search input
      try {
        await page.waitForSelector(
          ".all-properties__search input.fds-field-input"
        );
      } catch (error: any) {
        console.error("Error waiting for property search input:", error);
        
        // Send email notification for search input error
        if (jobId) {
          try {
            await emailNotifier.notifyJobError(
              jobId,
              `Failed to find property search input for reservation ${reservationId}: ${error?.message || "Search input not found"}`,
              error,
              {
                stage: "scrape_with_reservation_search_input",
                progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
              }
            );
          } catch (emailError) {
            console.error("Failed to send search input error notification:", emailError);
          }
        }
        throw error;
      }

      // Get property ID from query params
      console.log(`Searching for property ID: ${reservationId}`);

      // Type property ID in search
      try {
        await page.type(
          ".all-properties__search input.fds-field-input",
          String(reservationId),
          { delay: 500 }
        );
      } catch (error: any) {
        console.error("Error typing reservation ID:", error);
        
        // Send email notification for typing error
        if (jobId) {
          try {
            await emailNotifier.notifyJobError(
              jobId,
              `Failed to type reservation ID ${reservationId}: ${error?.message || "Typing failed"}`,
              error,
              {
                stage: "scrape_with_reservation_typing",
                progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
              }
            );
          } catch (emailError) {
            console.error("Failed to send typing error notification:", emailError);
          }
        }
        throw error;
      }

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
          const error = new Error(`Could not find property with ID: ${reservationId}`);
          
          // Send email notification for property not found
          if (jobId) {
            try {
              await emailNotifier.notifyJobError(
                jobId,
                `Property not found with reservation ID: ${reservationId}`,
                error,
                {
                  stage: "scrape_with_reservation_property_not_found",
                  progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
                }
              );
            } catch (emailError) {
              console.error("Failed to send property not found error notification:", emailError);
            }
          }
          
          throw error;
        }
      } catch (error: any) {
        console.error(`Error finding/clicking property: ${error.message}`);
        
        // Send email notification for property click error
        if (jobId) {
          try {
            await emailNotifier.notifyJobError(
              jobId,
              `Failed to find or click property for reservation ${reservationId}: ${error?.message || "Property click failed"}`,
              error,
              {
                stage: "scrape_with_reservation_property_click",
                progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
              }
            );
          } catch (emailError) {
            console.error("Failed to send property click error notification:", emailError);
          }
        }
        
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
        const error = new Error("Could not find or click Reservations link");
        
        // Send email notification for reservations link error
        if (jobId) {
          try {
            await emailNotifier.notifyJobError(
              jobId,
              `Failed to find or click Reservations link for reservation ${reservationId}`,
              error,
              {
                stage: "scrape_with_reservation_reservations_link",
                progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
              }
            );
          } catch (emailError) {
            console.error("Failed to send reservations link error notification:", emailError);
          }
        }
        
        throw error;
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
      try {
        await page.waitForSelector('input[type="radio"][name="dateTypeFilter"]', {
          visible: true,
          timeout: 80000,
        });
      } catch (error: any) {
        console.error("Error waiting for date filters:", error);
        
        // Send email notification for date filters error
        if (jobId) {
          try {
            await emailNotifier.notifyJobError(
              jobId,
              `Failed to find date filters for reservation ${reservationId}: ${error?.message || "Date filters not found"}`,
              error,
              {
                stage: "scrape_with_reservation_date_filters",
                progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
              }
            );
          } catch (emailError) {
            console.error("Failed to send date filters error notification:", emailError);
          }
        }
        throw error;
      }

      // Get the current URL
      const currentUrl = page.url();
      console.log(`Current tab URL: ${currentUrl}`);

      if (reservation && reservation.idList) {
        for (const chunk of reservation.idList) {
          console.log(`Processing id: ${chunk}`);

          try {
            await retryScrape(browser, page, reservationId, chunk, jobId);
          } catch (error: any) {
            console.error(`Error processing chunk ${chunk}:`, error);
            
            // Send email notification for chunk processing error
            if (jobId) {
              try {
                await emailNotifier.notifyJobError(
                  jobId,
                  `Failed to process chunk ${chunk} for reservation ${reservationId}: ${error?.message || "Chunk processing failed"}`,
                  error,
                  {
                    stage: "scrape_with_reservation_chunk_processing",
                    progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
                  }
                );
              } catch (emailError) {
                console.error("Failed to send chunk processing error notification:", emailError);
              }
            }
            
            // Continue with next chunk instead of failing completely
            continue;
          }
        }
      } else {
        const error = new Error("Reservation or idList is undefined");
        console.error("Reservation or idList is undefined");
        
        // Send email notification for missing reservation data
        if (jobId) {
          try {
            await emailNotifier.notifyJobError(
              jobId,
              `Reservation or idList is undefined for reservation ${reservationId}`,
              error,
              {
                stage: "scrape_with_reservation_missing_data",
                progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
              }
            );
          } catch (emailError) {
            console.error("Failed to send missing data error notification:", emailError);
          }
        }
        
        throw error;
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
            const error = new Error("Could not find navigation logo link");
            
            // Send email notification for navigation logo error
            if (jobId) {
              try {
                await emailNotifier.notifyJobError(
                  jobId,
                  `Failed to find navigation logo link for reservation ${reservationId}`,
                  error,
                  {
                    stage: "scrape_with_reservation_navigation_logo",
                    progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
                  }
                );
              } catch (emailError) {
                console.error("Failed to send navigation logo error notification:", emailError);
              }
            }
            
            throw error;
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
          
          // Send email notification for navigation failure
          if (jobId) {
            try {
              await emailNotifier.notifyJobError(
                jobId,
                `Failed to navigate to home page for reservation ${reservationId}: ${navError?.message || "Navigation failed"}`,
                navError,
                {
                  stage: "scrape_with_reservation_navigation_home",
                  progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
                }
              );
            } catch (emailError) {
              console.error("Failed to send navigation failure error notification:", emailError);
            }
          }
          
          // Don't throw here, this is just cleanup navigation
        }
      }

      // Add 5 second delay before processing next property
      console.log("Waiting 5 seconds before processing next property...");
      await delay(5000);
    } catch (error: any) {
      console.error("Error finding/clicking Reservations:", error.message);
      
      // Send email notification for reservations processing error
      if (jobId) {
        try {
          await emailNotifier.notifyJobError(
            jobId,
            `Failed to process reservations for reservation ${reservationId}: ${error?.message || "Reservations processing failed"}`,
            error,
            {
              stage: "scrape_with_reservation_reservations_processing",
              progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
            }
          );
        } catch (emailError) {
          console.error("Failed to send reservations processing error notification:", emailError);
        }
      }
      
      throw error;
    }
  } catch (error: any) {
    console.error("Error in scrapeWithReservationId:", error);
    
    // Send email notification for general scrapeWithReservationId error
    if (jobId) {
      try {
        await emailNotifier.notifyJobError(
          jobId,
          `scrapeWithReservationId failed for reservation ${reservation?.id || 'unknown'}: ${error?.message || "Unknown error"}`,
          error,
          {
            stage: "scrape_with_reservation_general",
            progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
          }
        );
      } catch (emailError) {
        console.error("Failed to send general scrapeWithReservationId error notification:", emailError);
      }
    }
    
    throw error;
  }
}

export default scrapeWithReservationId;
