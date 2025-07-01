import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { oauth2Client } from "../config/google-config.js";

dotenv.config();

// Function to load and set credentials
async function loadCredentials() {
  try {
    const tokenPath = process.env.TOKEN_PATH || "token.json";

    if (!fs.existsSync(tokenPath)) {
      throw new Error(
        `Token file not found at ${tokenPath}. Please run the authentication setup first.`
      );
    }

    const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));

    // Check if refresh token exists
    if (!token.refresh_token) {
      throw new Error(
        "No refresh token found. Please re-authenticate with offline access."
      );
    }

    oauth2Client.setCredentials(token);
    await dualLogInfo("Gmail credentials loaded successfully");
    return true;
  } catch (error) {
    await dualLogError("Error loading credentials:", error);
    return false;
  }
}

async function getVerificationCode() {
  try {
    // Load credentials before making API calls
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
    });

    if (!res.data.messages) {
      await dualLogInfo("No new emails found.");
      return null;
    }

    for (const msg of res.data.messages) {
      if (!msg.id) {
        continue;
      }

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
      });

      const body = email.data.snippet || "";
      await dualLogInfo("Email body:", body);
      const codeMatch = body.match(/\b\d{6,10}\b/);
      await dualLogInfo("Code match:", codeMatch);

      if (codeMatch) {
        return codeMatch[0];
      }
    }

    await dualLogInfo("No verification code found in recent emails.");
    return null;
  } catch (error: any) {
    await dualLogError("Error fetching emails:", error.message);
    return null;
  }
}

async function handleOtpVerification(
  browser: Browser,
  page: Page,
  jobId?: string
): Promise<void> {
  try {
    // Check if scraping is paused before starting OTP verification
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during OTP verification");
    }

    // Get timeout configuration for this job
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

    // Wait for verification code page using the correct selector
    await dualLogInfo("Waiting for verification page...");
    await page.waitForSelector('input[name="passcode-input"]', {
      visible: true,
      timeout: selectorTimeout,
    });
    const ourContact = process.env.OUR_CONTACT || "01828704004";

    // Extract the phone number from the verification message
    const currentContact = await page.evaluate(() => {
      const element = document.querySelector(
        '[data-testid="passcode-entry"] p b'
      );
      if (element) {
        return element.textContent?.trim();
      }
      return null;
    });

    await dualLogInfo(`Current contact from page: ${currentContact}`);
    await dualLogInfo(`Our contact: ${ourContact}`);

    // Compare last three digits
    const currentLastThree = currentContact ? currentContact.slice(-3) : "";
    const ourLastThree = ourContact.slice(-3);

    await dualLogInfo(`Current contact last 3 digits: ${currentLastThree}`);
    await dualLogInfo(`Our contact last 3 digits: ${ourLastThree}`);

    if (currentLastThree === ourLastThree) {
      await dualLogInfo(
        "Phone numbers match! Using email verification flow..."
      );

      // Add delay before fetching verification code
      await dualLogInfo("Waiting for verification email...");
      await delay(15000); // Wait 15 seconds for email to arrive

      // Get verification code
      const code = await getVerificationCode();
      if (!code) {
        throw new Error("Failed to get verification code from email");
      }
      await dualLogInfo("Got verification code:", code);

      // Enter verification code using the correct selector
      await page.type('input[name="passcode-input"]', code, { delay: 100 });
      await delay(1000);

      const verifyButtonHandle = await page.$(
        'button[data-testid="passcode-submit-button"]'
      );

      if (!verifyButtonHandle) {
        throw new Error("Verify button not found");
      }

      // Check if the button is disabled
      const isDisabled = await page.evaluate(
        (button) => button.disabled,
        verifyButtonHandle
      );

      if (isDisabled) {
        throw new Error("Verify button is disabled");
      }

      // Click the button
      await verifyButtonHandle.click();
      await dualLogInfo("Clicked the verify button successfully!");
    } else {
      await dualLogInfo(
        `Phone numbers don't match! Looking for fallback verification options...`
      );

      // Look for fallback verification options
      try {
        // Check if fallbacks section exists
        const fallbacksExists = await page
          .waitForSelector('[data-testid="fallbacks"]', {
            visible: true,
            timeout: selectorTimeout,
          })
          .catch(() => null);

        if (!fallbacksExists) {
          throw new Error("No fallback verification options found");
        }

        await dualLogInfo(
          "Found fallbacks section, clicking dropdown arrow..."
        );

        // Click the dropdown arrow to expand options
        await page.click('[data-testid="fallbacks-toggle"]');
        await delay(2000);

        // Wait for the dropdown to fully expand and items to be visible
        await dualLogInfo("Waiting for fallback items to be visible...");
        await page.waitForSelector('[data-testid="fallback-item"]', {
          visible: true,
          timeout: selectorTimeout,
        });

        // Additional wait to ensure all content is loaded
        await delay(3000);

        await dualLogInfo(
          "Dropdown opened, looking for matching phone number..."
        );

        // First, let's check if the elements exist at all
        const elementsExist = await page.evaluate(() => {
          try {
            const fallbackItems = document.querySelectorAll(
              '[data-testid="fallback-item"]'
            );
            const itemsInfo = [];

            for (let i = 0; i < fallbackItems.length; i++) {
              const item = fallbackItems[i];
              const phoneHeader = item.querySelector(
                ".fds-list-item-content-header"
              );
              const textLink = item.querySelector(".fds-list-item-link a");

              itemsInfo.push({
                hasPhoneHeader: !!phoneHeader,
                hasTextLink: !!textLink,
                phoneText: phoneHeader?.textContent?.trim() || "N/A",
                linkText: textLink?.textContent?.trim() || "N/A",
              });
            }

            return {
              success: true,
              itemCount: fallbackItems.length,
              items: itemsInfo,
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }
        });

        await dualLogInfo(
          "Elements check result:",
          JSON.stringify(elementsExist, null, 2)
        );

        if (!elementsExist || !elementsExist.success) {
          throw new Error(
            `Failed to check fallback elements: ${
              elementsExist?.error || "Unknown error"
            }`
          );
        }

        if (elementsExist.itemCount === 0) {
          throw new Error("No fallback items found in the dropdown");
        }

        // Now look for phone numbers in the fallback options
        const matchingOption = await page.evaluate(async (ourLastThree) => {
          try {
            await dualLogInfo("Looking for phone ending with:", ourLastThree);

            const fallbackItems = document.querySelectorAll(
              '[data-testid="fallback-item"]'
            );

            await dualLogInfo("Found fallback items:", fallbackItems.length);

            for (let i = 0; i < fallbackItems.length; i++) {
              const item = fallbackItems[i];
              const phoneHeader = item.querySelector(
                ".fds-list-item-content-header"
              );
              const textLink = item.querySelector(".fds-list-item-link a");

              if (phoneHeader && textLink) {
                const phoneNumber = phoneHeader.textContent?.trim() || "";
                const linkText = textLink.textContent?.trim() || "";

                await dualLogInfo("Found item:", phoneNumber);

                // Check if this is a phone number (contains asterisks and digits)
                if (
                  phoneNumber.includes("*") &&
                  linkText === "Send me a text"
                ) {
                  // Extract last 3 digits from the phone number
                  const phoneLastThree = phoneNumber.slice(-3);

                  if (phoneLastThree === ourLastThree) {
                    await dualLogInfo("Found matching phone number!");
                    return {
                      found: true,
                      phoneNumber: phoneNumber,
                      element: item,
                    };
                  }
                }
              }
            }

            await dualLogInfo("No matching phone number found");
            return { found: false, phoneNumber: null };
          } catch (error) {
            await dualLogError(
              "Error in page.evaluate:",
              error instanceof Error ? error.message : "Unknown error"
            );
            return {
              found: false,
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }
        }, ourLastThree);

        await dualLogInfo(`Matching option result:`, matchingOption);

        if (!matchingOption) {
          // If page.evaluate returned undefined, try a simpler approach
          await dualLogInfo(
            "page.evaluate returned undefined, trying alternative approach..."
          );

          // Try clicking on the first "Send me a text" link that contains digits ending with our number
          const alternativeClick = await page.evaluate((ourLastThree) => {
            try {
              const textLinks = Array.from(
                document.querySelectorAll(".fds-list-item-link a")
              );

              for (const link of textLinks) {
                if (link.textContent?.trim() === "Send me a text") {
                  const item = link.closest('[data-testid="fallback-item"]');
                  if (item) {
                    const phoneHeader = item.querySelector(
                      ".fds-list-item-content-header"
                    );
                    if (phoneHeader) {
                      const phoneNumber = phoneHeader.textContent?.trim() || "";
                      if (phoneNumber.slice(-3) === ourLastThree) {
                        (link as HTMLElement).click();
                        return { success: true, phoneNumber: phoneNumber };
                      }
                    }
                  }
                }
              }
              return {
                success: false,
                error: "No matching phone found in alternative approach",
              };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
              };
            }
          }, ourLastThree);

          if (alternativeClick.success) {
            await dualLogInfo(
              `Alternative approach succeeded: clicked 'Send me a text' for ${alternativeClick.phoneNumber}`
            );
            await delay(3000);

            // Continue with verification process
            await page.waitForSelector('input[name="passcode-input"]', {
              visible: true,
              timeout: selectorTimeout,
            });

            await dualLogInfo(
              "SMS verification page loaded, trying to get verification code from email..."
            );
            await delay(15000);

            const code = await getVerificationCode();
            if (!code) {
              throw new Error("Failed to get verification code from email");
            }
            await dualLogInfo("Got verification code:", code);

            await page.type('input[name="passcode-input"]', code, {
              delay: 100,
            });
            await delay(1000);

            const verifyButtonHandle = await page.$(
              'button[data-testid="passcode-submit-button"]'
            );
            if (!verifyButtonHandle) {
              throw new Error("Verify button not found");
            }

            const isDisabled = await page.evaluate(
              (button) => button.disabled,
              verifyButtonHandle
            );
            if (isDisabled) {
              throw new Error("Verify button is disabled");
            }

            await verifyButtonHandle.click();
            await dualLogInfo("Clicked the verify button successfully!");
          } else {
            throw new Error(
              `Both primary and alternative approaches failed: ${alternativeClick.error}`
            );
          }
        } else if (matchingOption.error) {
          throw new Error(`Error in page evaluation: ${matchingOption.error}`);
        } else if (matchingOption.found) {
          await dualLogInfo(
            `Found matching phone number: ${matchingOption.phoneNumber}`
          );

          // Click on "Send me a text" for the matching phone number
          const clickResult = await page.evaluate((ourLastThree) => {
            try {
              const fallbackItems = document.querySelectorAll(
                '[data-testid="fallback-item"]'
              );

              for (const item of fallbackItems) {
                const phoneHeader = item.querySelector(
                  ".fds-list-item-content-header"
                );
                const textLink = item.querySelector(".fds-list-item-link a");

                if (
                  phoneHeader &&
                  textLink &&
                  textLink.textContent?.trim() === "Send me a text"
                ) {
                  const phoneNumber = phoneHeader.textContent?.trim() || "";
                  if (phoneNumber.slice(-3) === ourLastThree) {
                    (textLink as HTMLElement).click();
                    return { success: true, phoneNumber: phoneNumber };
                  }
                }
              }
              return {
                success: false,
                error: "Could not find matching phone to click",
              };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
              };
            }
          }, ourLastThree);

          if (!clickResult.success) {
            throw new Error(
              `Failed to click "Send me a text": ${clickResult.error}`
            );
          }

          await dualLogInfo(
            `Clicked 'Send me a text' for phone: ${clickResult.phoneNumber}`
          );
          await delay(3000);

          // Wait for SMS verification page to load
          await page.waitForSelector('input[name="passcode-input"]', {
            visible: true,
            timeout: selectorTimeout,
          });

          await dualLogInfo(
            "SMS verification page loaded, trying to get verification code from email..."
          );

          // Add delay before fetching verification code
          await delay(15000); // Wait 15 seconds for email to arrive

          const code = await getVerificationCode();
          if (!code) {
            throw new Error("Failed to get verification code from email");
          }
          console.log("Got verification code:", code);

          // Enter verification code using the correct selector
          await page.type('input[name="passcode-input"]', code, { delay: 100 });
          await delay(1000);

          const verifyButtonHandle = await page.$(
            'button[data-testid="passcode-submit-button"]'
          );

          if (!verifyButtonHandle) {
            throw new Error("Verify button not found");
          }

          // Check if the button is disabled
          const isDisabled = await page.evaluate(
            (button) => button.disabled,
            verifyButtonHandle
          );

          if (isDisabled) {
            throw new Error("Verify button is disabled");
          }

          // Click the button
          await verifyButtonHandle.click();
          console.log("Clicked the verify button successfully!");
        } else {
          throw new Error(
            `No matching phone number found in fallback options. Expected ending with ${ourLastThree}. Available options: ${
              matchingOption.phoneNumber || "none found"
            }`
          );
        }
      } catch (fallbackError) {
        const errorMessage =
          fallbackError instanceof Error
            ? fallbackError.message
            : "Unknown error";
        console.log(`Error with fallback verification: ${errorMessage}`);
        throw new Error(
          `Phone number mismatch and fallback verification failed. Expected ending with ${ourLastThree}, but got ${currentLastThree}. Fallback error: ${errorMessage}`
        );
      }
    }

    // Wait for successful login
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    await page.waitForNavigation({
      waitUntil: "networkidle0",
      timeout: loadingTimeout,
    });

    console.log("Login successful!");
  } catch (error) {
    console.error("Error in handleOtpVerification:", error);
    // Close browser when done with this attempt
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
    throw error;
  }
}

export default handleOtpVerification;
