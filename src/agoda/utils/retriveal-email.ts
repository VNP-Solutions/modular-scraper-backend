/**
 * Agoda YCS Retrieval Email OTP Helper
 *
 * This module provides functionality to extract OTP (PIN) codes from Agoda YCS retrieval emails.
 *
 * Email Pattern:
 * From: Agoda <no-reply@account.agoda.com>
 * To: user_email (agodausername)
 * Subject: "One-time passcode for YCS login"
 * Body: Contains "Your PIN code for YCS login" and a 6-digit code
 *
 * Usage:
 * ```typescript
 * import { getYcsRetrievalOtpCode } from './retriveal-email.js';
 *
 * const result = await getYcsRetrievalOtpCode('user@example.com');
 * if (result.otpCode) {
 *   console.log('OTP Code:', result.otpCode);
 * }
 * ```
 */

import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { oauth2Client } from "../../config/google-config.js";

dotenv.config();

/**
 * Interface for YCS Retrieval OTP extraction result
 */
export interface YcsRetrievalOtpResult {
  otpCode: string | null;
  emailFound: boolean;
  emailSubject?: string;
  emailDate?: string;
}

/**
 * Load Gmail credentials and set them on oauth2Client
 */
async function loadCredentials(): Promise<boolean> {
  try {
    const tokenPath = process.env.TOKEN_PATH || "token.json";

    if (!fs.existsSync(tokenPath)) {
      throw new Error(
        `Token file not found at ${tokenPath}. Please complete authentication setup first.`
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
    await dualLogInfo(
      "Gmail credentials loaded successfully for YCS retrieval OTP extraction"
    );
    return true;
  } catch (error) {
    await dualLogError("Error loading credentials:", error);
    return false;
  }
}

/**
 * Get email body from Gmail message payload
 */
function getEmailBody(payload: any): string {
  let body = "";

  if (payload.body?.data) {
    // Plain text or HTML body
    body = Buffer.from(payload.body.data, "base64").toString("utf-8");
  } else if (payload.parts) {
    // Multipart message
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" || part.mimeType === "text/html") {
        if (part.body?.data) {
          body += Buffer.from(part.body.data, "base64").toString("utf-8");
        }
      } else if (part.parts) {
        // Nested parts
        body += getEmailBody(part);
      }
    }
  }

  return body;
}

/**
 * Check if an email matches YCS retrieval OTP email criteria
 */
function isYcsRetrievalOtpEmail(
  headers: any[],
  snippet: string,
  userEmail: string
): boolean {
  // Check sender
  const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from");
  const toHeader = headers.find((h) => h.name?.toLowerCase() === "to");
  const subjectHeader = headers.find(
    (h) => h.name?.toLowerCase() === "subject"
  );

  if (!fromHeader || !toHeader || !subjectHeader) {
    return false;
  }

  const fromValue = fromHeader.value.toLowerCase();
  const toValue = toHeader.value.toLowerCase();
  const subjectValue = subjectHeader.value.toLowerCase();
  const userEmailLower = userEmail.toLowerCase();

  // Check if it's from Agoda no-reply account
  const isFromAgoda =
    fromValue.includes("no-reply@account.agoda.com") ||
    fromValue.includes("agoda");

  // Check if it's sent to the user's email
  const isToUser = toValue.includes(userEmailLower);

  // Check subject
  const hasCorrectSubject = subjectValue.includes(
    "one-time passcode for ycs login"
  );

  // Check if it mentions YCS login PIN
  const hasYcsPinText =
    snippet.includes("PIN code for YCS login") ||
    snippet.includes("one-time PIN code") ||
    snippet.includes("YCS login");

  return isFromAgoda && isToUser && hasCorrectSubject && hasYcsPinText;
}

/**
 * Extract OTP/PIN code from YCS retrieval email body
 */
async function extractYcsRetrievalOtpCode(
  emailBody: string
): Promise<string | null> {
  await dualLogInfo(
    "🔍 Searching for OTP/PIN code in YCS retrieval email body..."
  );

  await dualLogInfo(`📧 Email body length: ${emailBody.length} characters`);

  // Log first 500 characters for debugging
  const preview = emailBody.substring(0, 500).replace(/\s+/g, " ");
  await dualLogInfo(`📄 Email preview: ${preview}...`);

  // Priority patterns for YCS retrieval OTP emails
  const otpPatterns = [
    // ULTRA HIGH PRIORITY: "Your one-time PIN code is:" followed by 6 digits (exact format from email)
    /Your one-time PIN code is:\s*(\d{6})/gi,
    /one-time PIN code is:\s*(\d{6})/gi,

    // HIGHEST PRIORITY: "Your PIN code for YCS login" followed by 6 digits
    /Your PIN code for YCS login[\s\S]*?(\d{6})/gi,
    /PIN code for YCS login[\s\S]*?(\d{6})/gi,

    // HIGH PRIORITY: "Your PIN code for YCS login" with flexible spacing
    /Your PIN code for YCS login[\s\S]*?(\d{3}\s*\d{3})/gi,
    /PIN code for YCS login[\s\S]*?(\d{3}\s*\d{3})/gi,

    // MEDIUM PRIORITY: 6 digits after "PIN code" or "OTP"
    /PIN code[\s\S]{0,100}?(\d{6})/gi,
    /OTP code[\s\S]{0,100}?(\d{6})/gi,

    // MEDIUM PRIORITY: Standalone 6 digits (word boundaries)
    /\b(\d{6})\b/g,
  ];

  for (let i = 0; i < otpPatterns.length; i++) {
    const pattern = otpPatterns[i];
    await dualLogInfo(`🔎 Trying OTP pattern ${i + 1}/${otpPatterns.length}`);

    const matches = Array.from(emailBody.matchAll(pattern));
    if (matches.length > 0) {
      await dualLogInfo(
        `✅ Found ${matches.length} matches with pattern ${i + 1}`
      );

      for (const match of matches) {
        const fullMatch = match[0];
        let otpCode = null;

        if (match[1]) {
          otpCode = match[1].trim();
          await dualLogInfo(
            `🔢 Pattern ${i + 1} found: "${fullMatch}" -> Code: ${otpCode}`
          );
        }

        if (otpCode) {
          // Clean up the code (remove spaces if any)
          let cleanOtp = otpCode.replace(/\s+/g, "");
          
          // Handle "3 digits + 3 digits" format (e.g., "068 913" -> "068913")
          if (cleanOtp.length === 6 && /^\d{6}$/.test(cleanOtp)) {
            // Already 6 digits, use as is
          } else if (cleanOtp.length > 6) {
            // Might have extra characters, try to extract just 6 digits
            const digitMatch = cleanOtp.match(/(\d{6})/);
            if (digitMatch) {
              cleanOtp = digitMatch[1];
            }
          }

          // Validate it's 6 digits AND not a known template value
          if (/^\d{6}$/.test(cleanOtp)) {
            // Filter out known template/CSS values
            const templateValues = [
              "737373", // CSS gray color
              "123456", // Template example
              "000000", // CSS black color
              "111111", // Template example
              "222222", // Template example
              "333333", // CSS dark gray
              "444444", // CSS gray
              "555555", // CSS gray
              "666666", // CSS gray
              "777777", // CSS gray
              "888888", // CSS gray
              "999999", // CSS light gray
              "ffffff", // CSS white
              "FFFFFF", // CSS white
            ];

            if (templateValues.includes(cleanOtp)) {
              await dualLogInfo(
                `❌ Skipping template/CSS value: ${cleanOtp} (not a real OTP)`
              );
              continue; // Skip this match and try the next one
            }

            await dualLogInfo(`✅ Valid 6-digit OTP code found: ${cleanOtp}`);
            return cleanOtp;
          } else {
            await dualLogInfo(
              `❌ Invalid OTP format: ${otpCode} (not 6 digits)`
            );
          }
        }
      }
    } else {
      await dualLogInfo(`❌ No matches found with pattern ${i + 1}`);
    }
  }

  await dualLogInfo("❌ No valid OTP code found in email body");
  return null;
}

/**
 * Get YCS Retrieval OTP code from recent emails
 * @param userEmail - The user's email address (agodausername) to filter emails
 * @param maxResults - Maximum number of emails to check (default: 5)
 * @param referenceCode - Optional reference code (extracted from page for logging, but NOT used for email matching as it's not in the email)
 * @returns Promise<YcsRetrievalOtpResult> - OTP code and email information
 */
export async function getYcsRetrievalOtpCode(
  userEmail: string,
  maxResults: number = 5,
  referenceCode?: string
): Promise<YcsRetrievalOtpResult> {
  try {
    // Load credentials before making API calls
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Search for emails from Agoda with YCS retrieval OTP subject
    // Search by subject and sender
    const searchQuery = `from:no-reply@account.agoda.com subject:"One-time passcode for YCS login" to:${userEmail}`;

    await dualLogInfo(
      `🔍 Searching for YCS retrieval OTP emails with query: ${searchQuery}`
    );

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: searchQuery,
      // Gmail returns messages in reverse chronological order (newest first) by default
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo(`No YCS retrieval OTP emails found for ${userEmail}.`);
      return {
        otpCode: null,
        emailFound: false,
      };
    }

    await dualLogInfo(
      `Found ${res.data.messages.length} potential YCS retrieval OTP emails (processing newest first)`
    );

    // Note: Reference code is NOT included in payout OTP emails, so we only filter by recipient email
    // Check each email for OTP code (emails are already sorted newest first)
    for (let i = 0; i < res.data.messages.length; i++) {
      const msg = res.data.messages[i];
      await dualLogInfo(
        `📧 Processing email ${i + 1}/${
          res.data.messages.length
        } (newest first)`
      );
      if (!msg.id) {
        continue;
      }

      try {
        const email = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "full",
        });

        const headers = email.data.payload?.headers || [];
        const snippet = email.data.snippet || "";

        // Verify this is actually a YCS retrieval OTP email
        if (!isYcsRetrievalOtpEmail(headers, snippet, userEmail)) {
          await dualLogInfo(
            `Skipping email ${i + 1} - doesn't match YCS retrieval OTP criteria`
          );
          continue;
        }

        const subjectHeader = headers.find(
          (h) => h.name?.toLowerCase() === "subject"
        );
        const dateHeader = headers.find(
          (h) => h.name?.toLowerCase() === "date"
        );

        await dualLogInfo(
          `Processing YCS retrieval OTP email: ${
            subjectHeader?.value || "Unknown subject"
          }`
        );

        if (dateHeader?.value) {
          await dualLogInfo(`📅 Email date: ${dateHeader.value}`);
        }

        // Get full email body
        const fullBody = getEmailBody(email.data.payload);

        // Log a preview of the email body for debugging
        const bodyPreview = fullBody.substring(0, 200).replace(/\s+/g, " ");
        await dualLogInfo(`📄 Email body preview: ${bodyPreview}...`);

        // Note: Reference code is NOT included in payout OTP emails
        // We only filter by recipient email address (already done in Gmail search query)
        // So we proceed directly to extract OTP code

        // Extract OTP code
        const otpCode = await extractYcsRetrievalOtpCode(fullBody);

        if (otpCode) {
          await dualLogInfo(`✅ YCS Retrieval OTP code found: ${otpCode}`);
          return {
            otpCode,
            emailFound: true,
            emailSubject: subjectHeader?.value || undefined,
            emailDate: dateHeader?.value || undefined,
          };
        } else {
          await dualLogInfo(
            "No OTP code found in this email, checking next..."
          );
        }
      } catch (emailError) {
        await dualLogError(`Error processing email ${msg.id}:`, emailError);
        continue;
      }
    }

    await dualLogInfo(
      "No OTP code found in any recent YCS retrieval OTP emails."
    );
    return {
      otpCode: null,
      emailFound: true, // Email was found but no OTP code extracted
    };
  } catch (error) {
    await dualLogError("Error fetching YCS retrieval OTP code:", error);
    return {
      otpCode: null,
      emailFound: false,
    };
  }
}
