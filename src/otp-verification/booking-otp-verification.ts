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

// Function to load and set credentials (reused from Expedia)
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

// Function to get verification code from email (reused from Expedia)
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

async function handleBookingOtpVerification(
  browser: Browser,
  page: Page,
  // jobId?: string
): Promise<void> {
  try {
    // Check if scraping is paused before starting OTP verification (skip in test mode)
    try {
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogInfo("Scraping state manager indicates stopped - continuing for test mode");
      }
    } catch (error) {
      await dualLogInfo("Scraping state manager not available - running in test mode");
    }

    // Get timeout configuration for this job
    // const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);
    const selectorTimeout = 30000; // Default 30 seconds

    await dualLogInfo("Looking for Booking.com verification method selection page...");

    // Check if we're on the verification method selection page
    const isVerificationPage = await page.evaluate(() => {
      return document.querySelector('.nw-step-header')?.textContent?.includes('Verification method') ||
             document.querySelector('.nw-signin-verification') !== null;
    });

    if (!isVerificationPage) {
      await dualLogInfo("Not on verification method selection page, checking for direct OTP input...");
      
      // Check if we're already on an OTP input page
      const hasOtpInput = await page.$('input[type="text"][maxlength="6"]') ||
                         await page.$('input[name="pin"]') ||
                         await page.$('input[name="code"]') ||
                         await page.$('input[placeholder*="code"]') ||
                         await page.$('input[autocomplete="one-time-code"]');
      
      if (!hasOtpInput) {
        throw new Error("Neither verification method selection nor OTP input page found");
      }
    } else {
      await dualLogInfo("Found verification method selection page, clicking SMS option...");
      
      // Click on SMS verification option
      const smsLinkClicked = await page.evaluate(() => {
        const smsLink = document.querySelector('.nw-sms-verification-link') as HTMLAnchorElement;
        if (smsLink) {
          smsLink.click();
          return true;
        }
        return false;
      });

      if (!smsLinkClicked) {
        throw new Error("SMS verification link not found");
      }

      await dualLogInfo("Clicked SMS verification, waiting for phone selection page...");
      await delay(3000);

      // Wait for navigation to phone selection page
      await page.waitForNavigation({
        waitUntil: "networkidle0",
        timeout: selectorTimeout,
      }).catch(() => {
        dualLogInfo("Navigation timeout, continuing...");
      });

      // Look for phone selection page and select the correct phone number
      const phoneSelected = await selectCorrectPhoneNumber(page /* , jobId */);
      if (!phoneSelected) {
        throw new Error("Failed to select correct phone number");
      }

      await dualLogInfo("Phone number selected, waiting for OTP input page...");
      await delay(5000);
    }

    // Now we should be on the OTP input page
    await dualLogInfo("Looking for OTP input field...");
    
    // Wait a bit for the page to load after clicking send button
    await delay(5000);
    
    // Take a screenshot for debugging
    try {
      await page.screenshot({ path: 'booking-otp-page-debug.png', fullPage: true });
      await dualLogInfo("Screenshot saved: booking-otp-page-debug.png");
    } catch (e) {
      await dualLogInfo("Failed to take screenshot for debugging");
    }
    
    // Log page URL and title for debugging
    const currentUrl = page.url();
    const pageTitle = await page.title();
    await dualLogInfo(`Current page URL: ${currentUrl}`);
    await dualLogInfo(`Current page title: ${pageTitle}`);
    
    // First, let's debug what input fields are actually present
    const allInputs = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map(input => ({
        type: input.type,
        name: input.name,
        id: input.id,
        className: input.className,
        placeholder: input.placeholder,
        maxLength: input.maxLength,
        inputMode: input.inputMode,
        autocomplete: input.autocomplete,
        outerHTML: input.outerHTML.substring(0, 200) // Truncate for readability
      }));
    });
    
    await dualLogInfo("All input fields found on page:", JSON.stringify(allInputs, null, 2));
    
    // Wait for OTP input field using multiple possible selectors
    let otpInputSelector = null;
    const otpSelectors = [
      // Original selectors
      'input[type="text"][maxlength="6"]',
      'input[name="pin"]',
      'input[name="code"]',
      'input[placeholder*="code" i]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
      // Additional comprehensive selectors
      'input[type="text"][maxlength="5"]',
      'input[type="text"][maxlength="7"]',
      'input[type="text"][maxlength="8"]',
      'input[type="number"]',
      'input[name="otp"]',
      'input[name="verification_code"]',
      'input[name="sms_code"]',
      'input[id*="code" i]',
      'input[id*="otp" i]',
      'input[id*="pin" i]',
      'input[class*="code" i]',
      'input[class*="otp" i]',
      'input[class*="pin" i]',
      'input[class*="verification" i]',
      'input[placeholder*="Enter" i]',
      'input[placeholder*="SMS" i]',
      'input[placeholder*="PIN" i]',
      'input[placeholder*="OTP" i]',
      'input[data-testid*="code" i]',
      'input[data-testid*="otp" i]',
      'input[data-testid*="pin" i]',
      // Broader selectors as fallbacks
      'input[type="text"]:not([type="email"]):not([type="password"])',
      'input[type="tel"]'
    ];

    for (const selector of otpSelectors) {
      try {
        await dualLogInfo(`Trying selector: ${selector}`);
        await page.waitForSelector(selector, {
          visible: true,
          timeout: 3000, // Reduce timeout per selector to 3 seconds
        });
        
        // Verify the field is actually visible and interactable
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isIntersectingViewport();
          const boundingBox = await element.boundingBox();
          
          if (isVisible && boundingBox) {
            otpInputSelector = selector;
            await dualLogInfo(`Found OTP input field: ${selector}`);
            break;
          } else {
            await dualLogInfo(`Selector ${selector} found but element not visible/interactable`);
          }
        }
      } catch (e) {
        await dualLogInfo(`Selector ${selector} failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
        continue;
      }
    }

    if (!otpInputSelector) {
      // Final fallback: look for any input that might be for OTP
      await dualLogInfo("No specific OTP selectors worked, trying generic approach...");
      
      const fallbackResult = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"]'));
        
        // Look for input that seems like OTP field based on characteristics
        for (const input of inputs) {
          const inputElement = input as HTMLInputElement;
          const maxLen = inputElement.maxLength;
          const placeholder = inputElement.placeholder?.toLowerCase() || '';
          const name = inputElement.name?.toLowerCase() || '';
          const id = inputElement.id?.toLowerCase() || '';
          const className = inputElement.className?.toLowerCase() || '';
          
          // Check if it looks like an OTP field
          if (
            (maxLen > 0 && maxLen <= 10) || // Reasonable length for OTP
            placeholder.includes('code') ||
            placeholder.includes('otp') ||
            placeholder.includes('pin') ||
            placeholder.includes('verification') ||
            name.includes('code') ||
            name.includes('otp') ||
            name.includes('pin') ||
            id.includes('code') ||
            id.includes('otp') ||
            id.includes('pin') ||
            className.includes('code') ||
            className.includes('otp') ||
            className.includes('pin')
          ) {
            let selector = '';
            if (inputElement.name) selector = `input[name="${inputElement.name}"]`;
            else if (inputElement.id) selector = `input[id="${inputElement.id}"]`;
            else if (inputElement.className) selector = `input[class*="${inputElement.className.split(' ')[0]}"]`;
            else selector = 'input[type="text"]';
            
            return { found: true, selector, element: inputElement.outerHTML.substring(0, 200) };
          }
        }
        
        // If still nothing, just return the first text input that's visible
        const firstTextInput = inputs.find(input => {
          const inputElement = input as HTMLInputElement;
          const rect = inputElement.getBoundingClientRect();
          return (inputElement.type === 'text' || inputElement.type === 'number' || inputElement.type === 'tel') && 
                 rect.width > 0 && rect.height > 0;
        });
        
        if (firstTextInput) {
          const inputElement = firstTextInput as HTMLInputElement;
          let selector = '';
          if (inputElement.name) selector = `input[name="${inputElement.name}"]`;
          else if (inputElement.id) selector = `input[id="${inputElement.id}"]`;
          else selector = 'input[type="text"]';
          
          return { found: true, selector, element: inputElement.outerHTML.substring(0, 200) };
        }
        
        return { found: false, selector: null, element: null };
      });
      
      if (fallbackResult.found && fallbackResult.selector) {
        try {
          await page.waitForSelector(fallbackResult.selector, { visible: true, timeout: 5000 });
          otpInputSelector = fallbackResult.selector;
          await dualLogInfo(`Found OTP input using fallback: ${fallbackResult.selector}`);
          await dualLogInfo(`Element HTML: ${fallbackResult.element}`);
        } catch (e) {
          await dualLogError(`Fallback selector also failed: ${fallbackResult.selector}`);
        }
      }
    }

    if (!otpInputSelector) {
      // Log page content for debugging
      const pageContent = await page.content();
      await dualLogInfo("Page content length:", pageContent.length);
      
      // Save page HTML for manual inspection
      try {
        require('fs').writeFileSync('booking-otp-page-debug.html', pageContent);
        await dualLogInfo("Page HTML saved to booking-otp-page-debug.html for manual inspection");
      } catch (e) {
        await dualLogInfo("Failed to save debug HTML file");
      }
      
      throw new Error("OTP input field not found after exhaustive search");
    }

    // Wait for SMS to arrive and get verification code from email
    await dualLogInfo("Waiting for verification email...");
    await delay(15000); // Wait 15 seconds for email to arrive

    const code = await getVerificationCode();
    if (!code) {
      throw new Error("Failed to get verification code from email");
    }
    await dualLogInfo("Got verification code:", code);

    // Enter verification code
    await page.type(otpInputSelector, code, { delay: 100 });
    await delay(1000);

    // Look for and click submit button
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:contains("Continue")',
      'button:contains("Verify")',
      'button:contains("Submit")'
    ];

    let submitClicked = false;
    for (const selector of submitSelectors) {
      try {
        if (selector.includes('contains')) {
          // Handle text-based selectors
          const clicked = await page.evaluate((buttonText) => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const button = buttons.find(btn => btn.textContent?.includes(buttonText.replace('button:contains("', '').replace('")', '')));
            if (button && !(button as HTMLButtonElement).disabled) {
              (button as HTMLElement).click();
              return true;
            }
            return false;
          }, selector);
          
          if (clicked) {
            await dualLogInfo(`Clicked submit button: ${selector}`);
            submitClicked = true;
            break;
          }
        } else {
          const submitButton = await page.$(selector);
          if (submitButton) {
            const isDisabled = await page.evaluate(
              (button) => (button as HTMLButtonElement).disabled,
              submitButton
            );
            
            if (!isDisabled) {
              await submitButton.click();
              await dualLogInfo(`Clicked submit button: ${selector}`);
              submitClicked = true;
              break;
            }
          }
        }
      } catch (e) {
        continue;
      }
    }

    if (!submitClicked) {
      // Try pressing Enter as fallback
      await page.keyboard.press('Enter');
      await dualLogInfo("Pressed Enter as fallback submit method");
    }

    // Wait for successful verification
    // const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const loadingTimeout = 120000; // Default 2 minutes
    await page.waitForNavigation({
      waitUntil: "networkidle0",
      timeout: loadingTimeout,
    }).catch(() => {
      dualLogInfo("Navigation timeout after OTP submission");
    });

    await dualLogInfo("Booking.com OTP verification completed successfully!");

  } catch (error) {
    await dualLogError("Error in handleBookingOtpVerification:", error);
    // Close browser when done with this attempt
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
    throw error;
  }
}

async function selectCorrectPhoneNumber(page: Page /* , jobId?: string */): Promise<boolean> {
  try {
    const ourContact = process.env.OUR_CONTACT || "01828704004";
    const ourLastThree = ourContact.slice(-3);
    
    await dualLogInfo(`Looking for phone number ending with: ${ourLastThree}`);
    
    // Wait for phone selection elements to load
    await delay(3000);
    
    // Check if we're on the phone selection page and find the correct phone
    const phoneSelected = await page.evaluate((targetLastThree) => {
      try {
        // First, look for select dropdown with phone options
        const phoneSelect = document.querySelector('select[name="selected_phone"]') as HTMLSelectElement;
        if (phoneSelect) {
          const options = Array.from(phoneSelect.options);
          for (const option of options) {
            const phoneText = option.textContent?.trim() || '';
            if (phoneText.includes('*') && phoneText.slice(-3) === targetLastThree) {
              phoneSelect.value = option.value;
              phoneSelect.dispatchEvent(new Event('change', { bubbles: true }));
              return { success: true, phoneNumber: phoneText, method: 'dropdown' };
            }
          }
        }
        
        // Fallback to original method - look for phone number elements
        const phoneElements = document.querySelectorAll('div[class*="phone"], span[class*="phone"], .verification-phone, [data-testid*="phone"], option');
        
        for (const element of phoneElements) {
          const phoneText = element.textContent?.trim() || '';
          if (phoneText.includes('*') || phoneText.includes('••')) {
            // Extract last 3 digits
            const lastThree = phoneText.slice(-3);
            if (lastThree === targetLastThree) {
              // Look for associated click element (button, link, etc.)
              const clickableParent = element.closest('button, a, [role="button"], .clickable') as HTMLElement;
              if (clickableParent) {
                clickableParent.click();
                return { success: true, phoneNumber: phoneText, method: 'click_parent' };
              }
              
              // If parent not clickable, try clicking the element itself
              (element as HTMLElement).click();
              return { success: true, phoneNumber: phoneText, method: 'click_element' };
            }
          }
        }
        
        // Additional fallback: look for any clickable element with phone pattern
        const clickableElements = document.querySelectorAll('button, a, [role="button"], .clickable');
        for (const element of clickableElements) {
          const text = element.textContent?.trim() || '';
          if ((text.includes('*') || text.includes('••')) && text.slice(-3) === targetLastThree) {
            (element as HTMLElement).click();
            return { success: true, phoneNumber: text, method: 'click_fallback' };
          }
        }
        
        return { success: false, error: 'No matching phone number found' };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }, ourLastThree);
    
    if (phoneSelected.success) {
      await dualLogInfo(`Selected phone number: ${phoneSelected.phoneNumber} using method: ${phoneSelected.method}`);
      
      // Now click the "Send verification code" button
      await delay(1000);
      
      const sendButtonClicked = await page.evaluate(() => {
        // Look for the specific send verification code button with the exact classes
        const sendButton = document.querySelector('button.nw-request-tfa') as HTMLButtonElement;

        console.log("================", sendButton)
        if (sendButton && sendButton.textContent?.includes('Send verification code')) {
          sendButton.click();
          return true;
        }
        
        // Fallback: look for button with the text "Send verification code"
        const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
        for (const button of buttons) {
          if (button.textContent?.includes('Send verification code')) {
            (button as HTMLButtonElement).click();
            return true;
          }
        }
        
        // Final fallback: look for any submit button in the form
        const submitButton = document.querySelector('form.nw-sms-verification button[type="submit"]') as HTMLButtonElement;
        if (submitButton) {
          submitButton.click();
          return true;
        }
        
        return false;
      });
      
      if (sendButtonClicked) {
        await dualLogInfo('Clicked "Send verification code" button');
        return true;
      } else {
        await dualLogError('Failed to find and click "Send verification code" button');
        return false;
      }
    } else {
      await dualLogError(`Failed to select phone: ${phoneSelected.error}`);
      return false;
    }
    
  } catch (error) {
    await dualLogError("Error selecting phone number:", error);
    return false;
  }
}

export default handleBookingOtpVerification;