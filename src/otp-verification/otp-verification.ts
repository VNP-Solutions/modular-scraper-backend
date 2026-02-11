import dotenv from "dotenv";
import { google } from "googleapis";
import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { loadAndSetCredentials } from "../common/load-token.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { oauth2Client } from "../config/google-config.js";

dotenv.config();

// Function to load and set credentials from S3
async function loadCredentials() {
  try {
    const tokenPath = process.env.TOKEN_PATH || "token.json";
    const success = await loadAndSetCredentials(tokenPath);

    if (!success) {
      throw new Error(
        "Failed to load Gmail credentials from S3 or local file. Please run the authentication setup first."
      );
    }

    await dualLogInfo("Gmail credentials loaded successfully from S3");
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
      q: "subject:Login attempt from SANJOSE, US to Partner Central Your verification code is", // Search by subject pattern
    });

    if (!res.data.messages) {
      await dualLogInfo(
        "No verification emails found with Partner Central verification code."
      );
      return null;
    }

    for (const msg of res.data.messages) {
      if (!msg.id) {
        continue;
      }

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full", // Get full email content instead of just snippet
      });

      // Check if email is from the correct sender
      const headers = email.data.payload?.headers || [];
      const fromHeader = headers.find(
        (header) => header.name?.toLowerCase() === "from"
      );
      const subjectHeader = headers.find(
        (header) => header.name?.toLowerCase() === "subject"
      );

      const fromEmail = fromHeader?.value || "";
      const subject = subjectHeader?.value || "";

      await dualLogInfo(`Email from: ${fromEmail}`);
      await dualLogInfo(`Email subject: ${subject}`);

      // Verify it has the correct subject pattern
      if (!subject.includes("Login attempt from SANJOSE, US to Partner Central Your verification code is")) {
        await dualLogInfo(
          "Skipping email - doesn't contain Partner Central verification code pattern"
        );
        continue;
      }

      // Get email body content
      let emailBody = "";

      // Try to get the email body from different payload structures
      if (email.data.payload?.body?.data) {
        emailBody = Buffer.from(
          email.data.payload.body.data,
          "base64"
        ).toString();
      } else if (email.data.payload?.parts) {
        // Handle multipart emails
        for (const part of email.data.payload.parts) {
          if (part.mimeType === "text/plain" && part.body?.data) {
            emailBody = Buffer.from(part.body.data, "base64").toString();
            break;
          }
        }
      }

      // If no body found, try snippet as fallback
      if (!emailBody) {
        emailBody = email.data.snippet || "";
      }

      await dualLogInfo("Email body content:", emailBody);

      // Look for verification code pattern: "Your verification code is XXXXXX"
      const codeMatch = emailBody.match(/Your verification code is (\d{6})/i);
      await dualLogInfo("Code match result:", codeMatch);

      if (codeMatch && codeMatch[1]) {
        await dualLogInfo(`Found verification code: ${codeMatch[1]}`);
        return codeMatch[1];
      }

      // Fallback: look for any 6-digit code in the email
      const fallbackMatch = emailBody.match(/\b\d{6}\b/);
      if (fallbackMatch) {
        await dualLogInfo(`Found fallback code: ${fallbackMatch[0]}`);
        return fallbackMatch[0];
      }
    }

    await dualLogInfo("No verification code found in Partner Central emails.");
    return null;
  } catch (error: any) {
    await dualLogError("Error fetching emails:", error.message);
    return null;
  }
}

/**
 * Helper function to clear OTP input field
 */
async function clearOtpInput(page: Page, inputSelector: string): Promise<void> {
  try {
    await dualLogInfo("Clearing input field for next attempt...");
    
    // Method 1: Use page.evaluate to directly clear the value (most reliable)
    await page.evaluate((selector) => {
      const input = document.querySelector(selector) as HTMLInputElement;
      if (input) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, inputSelector);
    
    await delay(300);
    
    // Method 2: Fallback - use keyboard to clear (works on all platforms)
    // Click to focus the input
    await page.click(inputSelector);
    await delay(200);
    
    // Triple-click to select all text (works on all platforms)
    await page.click(inputSelector, { clickCount: 3 });
    await delay(100);
    
    // Delete selected text
    await page.keyboard.press("Backspace");
    await delay(300);
    
    await dualLogInfo("Input field cleared successfully");
  } catch (error) {
    await dualLogError("Error clearing OTP input:", error);
  }
}

/**
 * Helper function to check if OTP verification failed
 * Looks for the error message: "Your verification code failed or has expired"
 */
async function hasOtpError(page: Page): Promise<boolean> {
  try {
    const errorExists = await page.evaluate(() => {
      const errorElement = document.querySelector('[data-testid="passcode-input-error"]');
      if (errorElement) {
        const errorText = errorElement.textContent || "";
        return errorText.includes("Your verification code failed or has expired") ||
               errorText.includes("verification code failed") ||
               errorText.includes("has expired");
      }
      return false;
    });
    return errorExists;
  } catch (error) {
    await dualLogError("Error checking for OTP error:", error);
    return false;
  }
}

/**
 * Try multiple OTP codes with retry logic
 * Returns true if any code succeeds, false if all fail
 */
async function tryMultipleOtpCodes(
  page: Page,
  codes: string[],
  selectorTimeout: number
): Promise<boolean> {
  const maxAttempts = Math.min(3, codes.length);
  let otpSuccess = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = codes[attempt];
    await dualLogInfo(
      `Attempt ${attempt + 1}/${maxAttempts}: Trying OTP ${code}`
    );

    // Enter verification code
    await page.type('input[name="passcode-input"]', code, { delay: 100 });
    await delay(1000);

    // Click verify button
    const verifyButtonHandle = await page.$(
      'button[data-testid="passcode-submit-button"]'
    );

    if (!verifyButtonHandle) {
      await dualLogError("Verify button not found");
      return false;
    }

    // Check if the button is disabled
    const isDisabled = await page.evaluate(
      (button) => button.disabled,
      verifyButtonHandle
    );

    if (isDisabled) {
      await dualLogError("Verify button is disabled");
      return false;
    }

    // Click the verify button
    await verifyButtonHandle.click();
    await dualLogInfo("Clicked the verify button");

    // Wait for response (either navigation or error message)
    await delay(2000);

    // Check if there's an error message
    const hasError = await hasOtpError(page);

    if (hasError) {
      await dualLogInfo(`Attempt ${attempt + 1} failed: Invalid or expired OTP code`);

      // If this was the 3rd attempt, fail
      if (attempt === 2) {
        await dualLogError(
          "OTP verification failed after 3 attempts. All codes were invalid or expired."
        );
        return false;
      }

      // Clear input field for next attempt
      await clearOtpInput(page, 'input[name="passcode-input"]');

      // Continue to next attempt
      continue;
    } else {
      // Success! No error message found
      await dualLogInfo(`Attempt ${attempt + 1} successful!`);
      otpSuccess = true;
      break;
    }
  }

  return otpSuccess;
}

/**
 * Get last 3 verification codes for Expedia Partner Central
 * Returns array of up to 3 OTP codes from most recent emails
 */
async function getMultipleVerificationCodes(): Promise<string[]> {
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
      maxResults: 10,
      q: "subject:Login attempt from SANJOSE, US to Partner Central Your verification code is", // Search by subject pattern
    });

    if (!res.data.messages) {
      await dualLogInfo(
        "No verification emails found with Partner Central verification code."
      );
      return [];
    }

    const codes: string[] = [];

    for (const msg of res.data.messages) {
      if (!msg.id) {
        continue;
      }

      // Stop if we already have 3 codes
      if (codes.length >= 3) {
        break;
      }

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full", // Get full email content instead of just snippet
      });

      // Check if email is from the correct sender
      const headers = email.data.payload?.headers || [];
      const subjectHeader = headers.find(
        (header) => header.name?.toLowerCase() === "subject"
      );

      const subject = subjectHeader?.value || "";

      // Verify it has the correct subject pattern
      if (!subject.includes("Login attempt from SANJOSE, US to Partner Central Your verification code is")) {
        continue;
      }

      // Get email body content
      let emailBody = "";

      // Try to get the email body from different payload structures
      if (email.data.payload?.body?.data) {
        emailBody = Buffer.from(
          email.data.payload.body.data,
          "base64"
        ).toString();
      } else if (email.data.payload?.parts) {
        // Handle multipart emails
        for (const part of email.data.payload.parts) {
          if (part.mimeType === "text/plain" && part.body?.data) {
            emailBody = Buffer.from(part.body.data, "base64").toString();
            break;
          }
        }
      }

      // If no body found, try snippet as fallback
      if (!emailBody) {
        emailBody = email.data.snippet || "";
      }

      // Look for verification code pattern: "Your verification code is XXXXXX"
      const codeMatch = emailBody.match(/Your verification code is (\d{6})/i);

      if (codeMatch && codeMatch[1]) {
        const code = codeMatch[1];
        // Only add if not already in list (avoid duplicates)
        if (!codes.includes(code)) {
          codes.push(code);
          await dualLogInfo(`Found verification code: ${code}`);
        }
      } else {
        // Fallback: look for any 6-digit code in the email
        const fallbackMatch = emailBody.match(/\b\d{6}\b/);
        if (fallbackMatch && !codes.includes(fallbackMatch[0])) {
          codes.push(fallbackMatch[0]);
          await dualLogInfo(`Found fallback code: ${fallbackMatch[0]}`);
        }
      }
    }

    await dualLogInfo(`Total verification codes found: ${codes.length}`);
    return codes;
  } catch (error: any) {
    await dualLogError("Error fetching multiple verification codes:", error.message);
    return [];
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
    try {
      await page.waitForSelector('input[name="passcode-input"]', {
        visible: true,
        timeout: selectorTimeout,
      });
    } catch (error: any) {
      await dualLogError("Error waiting for verification page:", error);

      // Send email notification for verification page error
      if (jobId) {
        try {
        } catch (emailError) {
          await dualLogError(
            "Failed to send verification page error notification:",
            emailError
          );
        }
      }
      throw error;
    }
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
      await delay(30000); // Wait 30 seconds for email to arrive

      // Get verification codes (up to 3)
      try {
        const codes = await getMultipleVerificationCodes();
        if (!codes || codes.length === 0) {
          const error = new Error("Failed to get verification codes from email");

          // Send email notification for verification code error
          if (jobId) {
            try {
            } catch (emailError) {
              await dualLogError(
                "Failed to send verification code error notification:",
                emailError
              );
            }
          }

          throw error;
        }
        await dualLogInfo(`Got ${codes.length} verification code(s)`);

        // Try up to 3 codes with retry logic
        const success = await tryMultipleOtpCodes(page, codes, selectorTimeout);
        
        if (!success) {
          const error = new Error("OTP verification failed after all attempts");

          // Send email notification for verification failure
          if (jobId) {
            try {
            } catch (emailError) {
              await dualLogError(
                "Failed to send verification failure notification:",
                emailError
              );
            }
          }

          throw error;
        }

        await dualLogInfo("OTP verification completed successfully!");
      } catch (error: any) {
        await dualLogError("Error in primary verification flow:", error);

        // Send email notification for primary verification error
        if (jobId) {
          try {
          } catch (emailError) {
            await dualLogError(
              "Failed to send primary verification error notification:",
              emailError
            );
          }
        }

        throw error;
      }
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
          const error = new Error("No fallback verification options found");

          // Send email notification for no fallback options
          if (jobId) {
            try {
            } catch (emailError) {
              await dualLogError(
                "Failed to send fallback options error notification:",
                emailError
              );
            }
          }

          throw error;
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
        await dualLogInfo("Looking for phone ending with:", ourLastThree);

        const matchingOption = await page.evaluate((ourLastThree) => {
          try {
            const fallbackItems = document.querySelectorAll(
              '[data-testid="fallback-item"]'
            );

            console.log("Found fallback items:", fallbackItems.length);

            for (let i = 0; i < fallbackItems.length; i++) {
              const item = fallbackItems[i];
              const phoneHeader = item.querySelector(
                ".fds-list-item-content-header"
              );
              const textLink = item.querySelector(".fds-list-item-link a");

              if (phoneHeader && textLink) {
                const phoneNumber = phoneHeader.textContent?.trim() || "";
                const linkText = textLink.textContent?.trim() || "";

                console.log("Found item:", phoneNumber);

                // Check if this is a phone number (contains asterisks and digits)
                if (
                  phoneNumber.includes("*") &&
                  linkText === "Send me a text"
                ) {
                  // Extract last 3 digits from the phone number
                  const phoneLastThree = phoneNumber.slice(-3);

                  if (phoneLastThree === ourLastThree) {
                    console.log("Found matching phone number!");
                    return {
                      found: true,
                      phoneNumber: phoneNumber,
                      element: item,
                    };
                  }
                }
              }
            }

            console.log("No matching phone number found");
            return { found: false, phoneNumber: null };
          } catch (error) {
            console.error(
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
            await delay(30000);

            const codes = await getMultipleVerificationCodes();
            if (!codes || codes.length === 0) {
              throw new Error("Failed to get verification codes from email");
            }
            await dualLogInfo(`Got ${codes.length} verification code(s)`);

            // Try up to 3 codes with retry logic
            const success = await tryMultipleOtpCodes(page, codes, selectorTimeout);
            
            if (!success) {
              throw new Error("OTP verification failed after all attempts");
            }

            await dualLogInfo("OTP verification completed successfully!");
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
          await delay(30000); // Wait 30 seconds for email to arrive

          const codes = await getMultipleVerificationCodes();
          if (!codes || codes.length === 0) {
            throw new Error("Failed to get verification codes from email");
          }
          await dualLogInfo(`Got ${codes.length} verification code(s)`);

          // Try up to 3 codes with retry logic
          const success = await tryMultipleOtpCodes(page, codes, selectorTimeout);
          
          if (!success) {
            throw new Error("OTP verification failed after all attempts");
          }

          await dualLogInfo("OTP verification completed successfully!");
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
        await dualLogError(`Error with fallback verification: ${errorMessage}`);

        // Send email notification for fallback verification error
        if (jobId) {
          try {
          } catch (emailError) {
            await dualLogError(
              "Failed to send fallback verification error notification:",
              emailError
            );
          }
        }

        throw new Error(
          `Phone number mismatch and fallback verification failed. Expected ending with ${ourLastThree}, but got ${currentLastThree}. Fallback error: ${errorMessage}`
        );
      }
    }

    // Wait for successful login
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    try {
      await page.waitForNavigation({
        waitUntil: "networkidle0",
        timeout: loadingTimeout,
      });
      console.log("Login successful!");
    } catch (error: any) {
      await dualLogError("Error waiting for navigation after OTP:", error);

      // Send email notification for navigation error
      if (jobId) {
        try {
        } catch (emailError) {
          await dualLogError(
            "Failed to send navigation error notification:",
            emailError
          );
        }
      }

      throw error;
    }
  } catch (error: any) {
    await dualLogError("Error in handleOtpVerification:", error);

    // Send email notification for general OTP verification error
    if (jobId) {
      try {
      } catch (emailError) {
        await dualLogError(
          "Failed to send general OTP error notification:",
          emailError
        );
      }
    }

    // Close browser when done with this attempt
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
    throw error;
  }
}

export default handleOtpVerification;
