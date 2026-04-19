/**
 * Agoda Email OTP Helper
 *
 * This module provides functionality to extract OTP (PIN) codes from Agoda emails.
 *
 * Key Features:
 * - Searches for emails from Agoda containing PIN codes
 * - Filters emails by sender (agoda.com, no-reply@account.agoda.com)
 * - Extracts 6-digit PIN codes from email content
 * - Handles both HTML and plain text email formats
 *
 * Usage:
 * ```typescript
 * import { getAgodaOtpCode } from './email-otp-helper.js';
 *
 * const result = await getAgodaOtpCode();
 * if (result.otpCode) {
 *   console.log('OTP Code:', result.otpCode);
 * }
 * ```
 *
 * Email Pattern Example:
 * From: Agoda <no-reply@account.agoda.com>
 * Subject: Your PIN code for logging into YCS
 * Content: "Your PIN code for logging into YCS is 056 721"
 */

import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { oauth2Client } from "../../config/google-config.js";

dotenv.config();

/**
 * Interface for Agoda OTP extraction result
 */
export interface AgodaOtpResult {
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
    await dualLogInfo(
      "Gmail credentials loaded successfully for OTP extraction"
    );
    return true;
  } catch (error) {
    await dualLogError("Error loading credentials:", error);
    return false;
  }
}

/**
 * Check if an email is from Agoda and contains OTP/PIN code
 */
function isAgodaOtpEmail(headers: any[], snippet: string): boolean {
  // Check sender
  const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from");
  const subjectHeader = headers.find(
    (h) => h.name?.toLowerCase() === "subject"
  );

  if (!fromHeader || !subjectHeader) {
    return false;
  }

  const fromValue = fromHeader.value.toLowerCase();
  const subjectValue = subjectHeader.value.toLowerCase();

  // Check if it's from Agoda
  const isFromAgoda =
    fromValue.includes("agoda") ||
    fromValue.includes("no-reply@account.agoda.com");

  // Check if it's an OTP/PIN related email
  const isOtpEmail =
    subjectValue.includes("pin") ||
    subjectValue.includes("otp") ||
    subjectValue.includes("code") ||
    subjectValue.includes("ycs") ||
    snippet.includes("PIN code") ||
    snippet.includes("OTP") ||
    snippet.includes("logging into YCS");

  return isFromAgoda && isOtpEmail;
}

/**
 * Extract OTP/PIN code from email body
 */
async function extractOtpCode(emailBody: string): Promise<string | null> {
  await dualLogInfo("🔍 Searching for OTP/PIN code in email body...");

  // Look for various patterns of OTP codes - ordered by priority (most specific first)
  const otpPatterns = [
    // ULTRA HIGH PRIORITY: Find non-commented spans (actual visible OTP)
    /(?:Your PIN code|PIN code)[\s\S]*?YCS is[\s\S]*?<span>(\d{3})<\/span>\s*<span>(\d{3})<\/span>/gi,

    // HIGHEST PRIORITY: Handle HTML span structure - avoid commented ones
    /Your PIN code for logging into YCS is[\s\S]*?(?!<!--).*?(\d{3})[\s\S]*?(\d{3})(?!.*-->)/gi,
    /PIN code for logging into YCS is[\s\S]*?(?!<!--).*?(\d{3})[\s\S]*?(\d{3})(?!.*-->)/gi,

    // HIGH PRIORITY: Standard format with flexible spacing
    /Your PIN code for logging into YCS is\s*(\d{3}\s*\d{3})/gi,
    /PIN code for logging into YCS is\s*(\d{3}\s*\d{3})/gi,

    // MEDIUM PRIORITY: More flexible patterns - avoid commented sections
    /Your PIN code.*?YCS is[\s\S]*?(?!<!--).*?(\d{3})[\s\S]*?(\d{3})(?!.*-->)/gi,
    /PIN code.*?YCS is[\s\S]*?(?!<!--).*?(\d{3})[\s\S]*?(\d{3})(?!.*-->)/gi,
    /Your PIN code.*?YCS.*?(\d{3}\s*\d{3})/gi,
    /PIN code.*?YCS.*?(\d{3}\s*\d{3})/gi,

    // MEDIUM PRIORITY: 6 digits together formats
    /Your PIN code for logging into YCS is\s*(\d{6})/gi,
    /PIN code for logging into YCS is\s*(\d{6})/gi,
    /Your PIN code.*?YCS is[\s\S]*?(\d{6})/gi,
    /PIN code.*?YCS is[\s\S]*?(\d{6})/gi,

    // LOWER PRIORITY: Context-based patterns
    /(\d{3}\s*\d{3})(?:\s*(?:Please enter|Enter this code|on the YCS sign-in screen))/gi,
    /(\d{6})(?:\s*(?:Please enter|Enter this code|on the YCS sign-in screen))/gi,

    // LOWEST PRIORITY: Generic patterns (very low priority to avoid CSS/HTML matches)
    /(?:^|\s)(\d{3}\s*\d{3})(?:\s|$)/gm, // Only match at word boundaries
    /(?:^|\s)(\d{6})(?:\s|$)/gm, // Only match at word boundaries
  ];

  await dualLogInfo(`📧 Email body length: ${emailBody.length} characters`);

  // Log first 500 characters for debugging
  const preview = emailBody.substring(0, 500).replace(/\s+/g, " ");
  await dualLogInfo(`📄 Email preview: ${preview}...`);

  // Look for the specific Agoda PIN text in the email
  const pinTextMatch = emailBody.match(
    /Your PIN code for logging into YCS is[\s\S]*?(\d{3}\s+\d{3})/i
  );
  if (pinTextMatch) {
    await dualLogInfo(
      `🎯 Found Agoda PIN context: "${pinTextMatch[0]}" -> Code: ${pinTextMatch[1]}`
    );
  } else {
    await dualLogInfo(
      "❌ Agoda PIN context not found, trying broader patterns..."
    );

    // DEBUG: Let's see what the actual email contains around PIN/OTP text
    await dualLogInfo("🔍 DEBUG: Searching for PIN-related content...");

    const debugPatterns = [
      { name: "PIN code text", pattern: /PIN code[\s\S]{0,50}/gi },
      { name: "YCS text", pattern: /YCS[\s\S]{0,50}/gi },
      {
        name: "span structure",
        pattern: /<span>\d{3}<\/span>[\s\S]*?<span>\d{3}<\/span>/gi,
      },
      { name: "span digits", pattern: /<span>(\d{3})<\/span>/gi },
      { name: "logging text", pattern: /logging[\s\S]{0,50}/gi },
      { name: "3+3 digits", pattern: /\d{3}\s+\d{3}/g },
      { name: "6 digits", pattern: /\d{6}/g },
    ];

    for (const debug of debugPatterns) {
      const matches = emailBody.match(debug.pattern);
      if (matches) {
        await dualLogInfo(
          `🔎 ${debug.name} found: ${matches.slice(0, 3).join(", ")}${
            matches.length > 3 ? ` (${matches.length} total)` : ""
          }`
        );
      }
    }

    // Let's also try to find any text that mentions PIN or code
    const broadPinMatch = emailBody.match(/PIN[\s\S]{0,100}/gi);
    if (broadPinMatch) {
      await dualLogInfo(
        `🔍 Found PIN text: ${broadPinMatch[0].substring(0, 100)}...`
      );
    }
  }

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

        // Handle patterns with two capture groups (for span structure)
        if (
          match[2] &&
          match[1] &&
          /^\d{3}$/.test(match[1]) &&
          /^\d{3}$/.test(match[2])
        ) {
          otpCode = match[1] + match[2]; // Combine the two 3-digit groups
          await dualLogInfo(
            `🔢 Pattern ${
              i + 1
            } found (span structure): "${fullMatch}" -> Groups: ${match[1]} + ${
              match[2]
            } = ${otpCode}`
          );
        } else if (match[1]) {
          otpCode = match[1].trim();
          await dualLogInfo(
            `🔢 Pattern ${i + 1} found: "${fullMatch}" -> Code: ${otpCode}`
          );
        }

        if (otpCode) {
          // Clean up the code (remove spaces if any)
          const cleanOtp = otpCode.replace(/\s+/g, "");

          // Validate it's 6 digits AND not a known template value
          if (/^\d{6}$/.test(cleanOtp)) {
            // Filter out known template/CSS values that appear in email HTML
            const templateValues = [
              "737373", // CSS gray color #737373
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
              "ffffff", // CSS white (if lowercase)
              "FFFFFF", // CSS white (if uppercase)
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

  // Smart fallback: Extract visible spans first, then any 6 digits
  await dualLogInfo(
    "🔄 No priority patterns found, trying smart fallback extraction..."
  );

  // First try: Find all visible (non-commented) spans
  const visibleSpanPattern = /(?<!<!--[\s\S]*?)<span>(\d{3})<\/span>/g;
  const spanMatches = Array.from(emailBody.matchAll(visibleSpanPattern));

  if (spanMatches.length >= 2) {
    await dualLogInfo(`🎯 Found ${spanMatches.length} visible span elements`);

    // Take the last two spans (most likely to be the real OTP)
    const lastTwo = spanMatches.slice(-2);
    const combinedCode = lastTwo[0][1] + lastTwo[1][1];

    await dualLogInfo(
      `🔢 Combining last two spans: ${lastTwo[0][1]} + ${lastTwo[1][1]} = ${combinedCode}`
    );

    // Filter out template values
    const templateValues = [
      "737373",
      "123456",
      "000000",
      "111111",
      "222222",
      "333333",
      "444444",
      "555555",
      "666666",
      "777777",
      "888888",
      "999999",
      "ffffff",
      "FFFFFF",
    ];

    if (!templateValues.includes(combinedCode)) {
      await dualLogInfo(`✅ Using span-based code: ${combinedCode}`);
      return combinedCode;
    } else {
      await dualLogInfo(
        `❌ Span-based code is template value: ${combinedCode}`
      );
    }
  }

  // Last resort: Look for any 6 digits (excluding CSS colors)
  await dualLogInfo(
    "🔄 Trying last resort: any 6 digits (excluding CSS colors)..."
  );

  const fallbackPattern = /\b\d{6}\b/g;
  const fallbackMatches = Array.from(emailBody.matchAll(fallbackPattern));

  if (fallbackMatches.length > 0) {
    await dualLogInfo(`🔗 Found ${fallbackMatches.length} 6-digit sequences`);

    // Take the first valid 6-digit sequence that's not a template value
    for (const match of fallbackMatches) {
      const code = match[0];
      await dualLogInfo(`🔢 Checking 6-digit sequence: ${code}`);

      // Filter out CSS colors and template values
      const templateValues = [
        "737373",
        "123456",
        "000000",
        "111111",
        "222222",
        "333333",
        "444444",
        "555555",
        "666666",
        "777777",
        "888888",
        "999999",
        "ffffff",
        "FFFFFF",
      ];

      if (/^\d{6}$/.test(code) && !templateValues.includes(code)) {
        await dualLogInfo(`✅ Using fallback 6-digit code: ${code}`);
        return code;
      } else {
        await dualLogInfo(`❌ Skipping template/CSS value: ${code}`);
      }
    }
  }

  await dualLogError("❌ No OTP code found in email body");
  return null;
}

/**
 * Get the full email body content including HTML parts
 */
function getEmailBody(payload: any): string {
  let body = "";

  // Extract body from direct body data
  if (payload.body && payload.body.data) {
    const decoded = Buffer.from(payload.body.data, "base64").toString();
    body += decoded;
  }

  // Extract from parts (multipart emails)
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      // Process text and HTML parts
      if (part.mimeType === "text/html" || part.mimeType === "text/plain") {
        if (part.body && part.body.data) {
          const decoded = Buffer.from(part.body.data, "base64").toString();
          body += decoded + "\n";
        }
      }

      // Handle multipart/alternative and other nested structures
      if (part.parts && Array.isArray(part.parts)) {
        body += getEmailBody(part);
      }

      // Handle multipart/related and other nested content
      if (part.mimeType?.startsWith("multipart/")) {
        body += getEmailBody(part);
      }
    }
  }

  return body;
}

/**
 * Get Agoda OTP code from recent emails
 */
export async function getAgodaOtpCode(
  maxResults: number = 5
): Promise<AgodaOtpResult> {
  try {
    // Load credentials before making API calls
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Search for emails from Agoda with OTP/PIN related content (sorted by newest first)
    const searchQuery =
      "from:agoda.com OR from:no-reply@account.agoda.com subject:(PIN OR OTP OR code OR YCS)";

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: searchQuery,
      // Gmail returns messages in reverse chronological order (newest first) by default
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo("No Agoda OTP emails found.");
      return {
        otpCode: null,
        emailFound: false,
      };
    }

    await dualLogInfo(
      `Found ${res.data.messages.length} potential Agoda OTP emails (processing newest first)`
    );

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

        // Verify this is actually an Agoda OTP email
        if (!isAgodaOtpEmail(headers, snippet)) {
          continue;
        }

        const subjectHeader = headers.find(
          (h) => h.name?.toLowerCase() === "subject"
        );
        const dateHeader = headers.find(
          (h) => h.name?.toLowerCase() === "date"
        );

        await dualLogInfo(
          `Processing Agoda OTP email: ${
            subjectHeader?.value || "Unknown subject"
          }`
        );

        if (dateHeader?.value) {
          await dualLogInfo(`📅 Email date: ${dateHeader.value}`);
        }

        // Get full email body
        const fullBody = getEmailBody(email.data.payload);

        // Extract OTP code
        const otpCode = await extractOtpCode(fullBody);

        if (otpCode) {
          await dualLogInfo(`OTP code found: ${otpCode}`);
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

    await dualLogInfo("No OTP code found in any recent Agoda emails.");
    return {
      otpCode: null,
      emailFound: true,
    };
  } catch (error: any) {
    await dualLogError("Error fetching Agoda OTP emails:", error.message);
    return {
      otpCode: null,
      emailFound: false,
    };
  }
}

/**
 * Test the OTP extraction with a sample email body
 */
export async function testOtpPatterns(sampleEmailBody: string): Promise<void> {
  try {
    await dualLogInfo("🧪 Testing OTP patterns with sample email...");
    const result = await extractOtpCode(sampleEmailBody);
    if (result) {
      await dualLogInfo(`✅ Test successful! Extracted OTP: ${result}`);
    } else {
      await dualLogInfo("❌ Test failed! No OTP extracted");
    }
  } catch (error) {
    await dualLogError("Error testing OTP patterns:", error);
  }
}

/**
 * Example usage function for testing the Agoda OTP extraction
 */
export async function testAgodaOtpExtraction(): Promise<void> {
  try {
    await dualLogInfo("Testing Agoda email OTP extraction...");

    // Test with sample email first
    const sampleEmail = `
      Agoda
      Your PIN code for logging into YCS is
      429 624
      Please enter this code on the YCS sign-in screen to complete login to your YCS account.
    `;

    await testOtpPatterns(sampleEmail);

    const result = await getAgodaOtpCode(10);

    if (result.otpCode) {
      await dualLogInfo("✅ OTP code found successfully!");
      await dualLogInfo(`Code: ${result.otpCode}`);
      if (result.emailSubject) {
        await dualLogInfo(`Email Subject: ${result.emailSubject}`);
      }
      if (result.emailDate) {
        await dualLogInfo(`Email Date: ${result.emailDate}`);
      }
    } else if (result.emailFound) {
      await dualLogInfo("📧 Agoda emails found but no OTP code extracted");
    } else {
      await dualLogInfo("❌ No Agoda OTP emails found");
    }
  } catch (error) {
    await dualLogError("Error testing Agoda OTP extraction:", error);
  }
}

/**
 * Check whether an email matches the YCS payout ("One-time passcode for YCS login")
 * template, scoped to the current agoda user's mailbox. Mirrors the retrieval proxy
 * branch's `isYcsRetrievalOtpEmail` so we do not accidentally pick up an old login PIN.
 */
function isYcsPayoutOtpEmail(
  headers: any[],
  snippet: string,
  userEmail: string
): boolean {
  const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from");
  const toHeader = headers.find((h) => h.name?.toLowerCase() === "to");
  const subjectHeader = headers.find(
    (h) => h.name?.toLowerCase() === "subject"
  );
  if (!fromHeader || !toHeader || !subjectHeader) return false;

  const fromValue = (fromHeader.value || "").toLowerCase();
  const toValue = (toHeader.value || "").toLowerCase();
  const subjectValue = (subjectHeader.value || "").toLowerCase();
  const userEmailLower = userEmail.toLowerCase();

  const isFromAgoda =
    fromValue.includes("no-reply@account.agoda.com") ||
    fromValue.includes("agoda");
  const isToUser = toValue.includes(userEmailLower);
  const hasCorrectSubject = subjectValue.includes(
    "one-time passcode for ycs login"
  );
  const hasYcsPinText =
    snippet.includes("PIN code for YCS login") ||
    snippet.includes("one-time PIN code") ||
    snippet.includes("YCS login");

  return isFromAgoda && isToUser && hasCorrectSubject && hasYcsPinText;
}

/**
 * Extract the 6-digit PIN from a YCS payout OTP email body. Patterns ported from the
 * retrieval proxy branch (`extractYcsRetrievalOtpCode`) where they are proven to work.
 */
async function extractYcsPayoutOtpCode(
  emailBody: string
): Promise<string | null> {
  await dualLogInfo(
    `🔍 Extracting YCS payout OTP from body (len=${emailBody.length})`
  );

  const patterns: RegExp[] = [
    /Your one-time PIN code is:\s*(\d{6})/gi,
    /one-time PIN code is:\s*(\d{6})/gi,
    /Your PIN code for YCS login[\s\S]*?(\d{6})/gi,
    /PIN code for YCS login[\s\S]*?(\d{6})/gi,
    /Your PIN code for YCS login[\s\S]*?(\d{3}\s*\d{3})/gi,
    /PIN code for YCS login[\s\S]*?(\d{3}\s*\d{3})/gi,
    /PIN code[\s\S]{0,100}?(\d{6})/gi,
    /OTP code[\s\S]{0,100}?(\d{6})/gi,
    /\b(\d{6})\b/g,
  ];

  const templateValues = new Set([
    "737373",
    "123456",
    "000000",
    "111111",
    "222222",
    "333333",
    "444444",
    "555555",
    "666666",
    "777777",
    "888888",
    "999999",
    "ffffff",
    "FFFFFF",
  ]);

  for (const pattern of patterns) {
    const matches = Array.from(emailBody.matchAll(pattern));
    for (const match of matches) {
      if (!match[1]) continue;
      let code = match[1].replace(/\s+/g, "");
      if (code.length > 6) {
        const six = code.match(/(\d{6})/);
        if (six) code = six[1];
      }
      if (/^\d{6}$/.test(code) && !templateValues.has(code)) {
        await dualLogInfo(`✅ Valid 6-digit YCS payout OTP: ${code}`);
        return code;
      }
    }
  }
  return null;
}

/**
 * YCS payout OTP helper. Uses the same Gmail query as the retrieval proxy branch —
 *   `from:no-reply@account.agoda.com subject:"One-time passcode for YCS login" to:<user>`
 * which is much more specific than the login PIN helper and picks up the freshest
 * payout code for the booking that triggered verification.
 */
export async function getYcsPayoutOtpCode(
  userEmail: string,
  maxResults: number = 5
): Promise<AgodaOtpResult> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials for YCS payout OTP retrieval."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const searchQuery = `from:no-reply@account.agoda.com subject:"One-time passcode for YCS login" to:${userEmail}`;
    await dualLogInfo(
      `🔍 Searching for YCS payout OTP emails with query: ${searchQuery}`
    );

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: searchQuery,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo(`No YCS payout OTP emails found for ${userEmail}.`);
      return { otpCode: null, emailFound: false };
    }

    for (let i = 0; i < res.data.messages.length; i++) {
      const msg = res.data.messages[i];
      if (!msg.id) continue;
      try {
        const email = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "full",
        });
        const headers = email.data.payload?.headers || [];
        const snippet = email.data.snippet || "";
        if (!isYcsPayoutOtpEmail(headers, snippet, userEmail)) continue;

        const subjectHeader = headers.find(
          (h) => h.name?.toLowerCase() === "subject"
        );
        const dateHeader = headers.find(
          (h) => h.name?.toLowerCase() === "date"
        );
        const fullBody = getEmailBody(email.data.payload);
        const otpCode = await extractYcsPayoutOtpCode(fullBody);
        if (otpCode) {
          return {
            otpCode,
            emailFound: true,
            emailSubject: subjectHeader?.value || undefined,
            emailDate: dateHeader?.value || undefined,
          };
        }
      } catch (emailError) {
        await dualLogError(`Error processing email ${msg.id}:`, emailError);
        continue;
      }
    }

    return { otpCode: null, emailFound: true };
  } catch (error: any) {
    await dualLogError(
      "Error fetching YCS payout OTP emails:",
      error?.message || error
    );
    return { otpCode: null, emailFound: false };
  }
}

/**
 * YCS payout OTP retry helper. Returns **every** 6-digit PIN found in the newest
 * matching YCS payout emails (ordered newest → oldest, deduplicated). Used by
 * `fillPayoutOtpInFrame` to retry through multiple codes when Agoda reports
 * "The OTP code is incorrect" — older codes in the same window can still be valid
 * if the one we grabbed raced with a newer email delivery.
 */
export async function getYcsPayoutOtpCodes(
  userEmail: string,
  maxResults: number = 10
): Promise<{
  otpCodes: string[];
  emailFound: boolean;
}> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials for YCS payout OTP retrieval."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const searchQuery = `from:no-reply@account.agoda.com subject:"One-time passcode for YCS login" to:${userEmail}`;
    await dualLogInfo(
      `🔍 Searching for all YCS payout OTP emails with query: ${searchQuery}`
    );

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: searchQuery,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo(`No YCS payout OTP emails found for ${userEmail}.`);
      return { otpCodes: [], emailFound: false };
    }

    const otps: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < res.data.messages.length; i++) {
      const msg = res.data.messages[i];
      if (!msg.id) continue;
      try {
        const email = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "full",
        });
        const headers = email.data.payload?.headers || [];
        const snippet = email.data.snippet || "";
        if (!isYcsPayoutOtpEmail(headers, snippet, userEmail)) continue;

        const dateHeader = headers.find(
          (h) => h.name?.toLowerCase() === "date"
        );
        const fullBody = getEmailBody(email.data.payload);
        const otpCode = await extractYcsPayoutOtpCode(fullBody);
        if (otpCode && !seen.has(otpCode)) {
          seen.add(otpCode);
          otps.push(otpCode);
          await dualLogInfo(
            `📬 Collected payout OTP #${otps.length}: ${otpCode}${
              dateHeader?.value ? ` (${dateHeader.value})` : ""
            }`
          );
        }
      } catch (emailError) {
        await dualLogError(`Error processing email ${msg.id}:`, emailError);
        continue;
      }
    }

    return { otpCodes: otps, emailFound: true };
  } catch (error: any) {
    await dualLogError(
      "Error fetching YCS payout OTP emails (multi):",
      error?.message || error
    );
    return { otpCodes: [], emailFound: false };
  }
}
