import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { getJobPhoneAndPort } from "../common/job-phone-store.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { oauth2Client } from "../config/google-config.js";

dotenv.config();

/** OTP email sources: IFTTT and rfitsms (to IT support). */
const OTP_EMAIL_FROM_IFTTT = "action@ifttt.com";
const OTP_EMAIL_FROM_RFITSMS = "rfitsms@gmail.com";
const OTP_EMAIL_TO_ITSUPPORT = "itsupport@vnpsolutions.com";

/** Parsed SMS-forwarded email (e.g. PORT 9 SMS / IFTTT). We match only by slot (from header or Receiver). */
export interface ParsedOtpEmail {
  slot: string;   // e.g. "9" from Subject "PORT 9 SMS" or from Receiver "9.01"
  code: string;   // 6-digit Extranet/PIN code
}

/**
 * Extract slot from email (header preferred, then body).
 * - Header: Subject "PORT 9 SMS" → slot "9"
 * - Body: Receiver: "9.01" → first value before the dot → slot "9"
 */
function extractSlotFromEmail(bodyText: string, subject?: string): string {
  if (subject) {
    const portMatch = subject.match(/PORT\s*(\d+)/i);
    if (portMatch && portMatch[1]) return portMatch[1].trim();
  }
  const receiverMatch = bodyText.match(/Receiver:\s*["']?(\d+)\./i);
  if (receiverMatch && receiverMatch[1]) return receiverMatch[1].trim();
  return "";
}

/**
 * Parse OTP email: get slot (from Subject or Receiver "X.XX" → X) and Extranet/PIN code.
 * We do NOT use Sender; matching is by slot only.
 */
export function parseOtpEmailSenderSlotAndCode(
  bodyText: string,
  subject?: string
): ParsedOtpEmail | null {
  const codeMatch = bodyText.match(/(?:Extranet|PIN)\s+code:\s*(\d{6})/i);
  if (!codeMatch || !codeMatch[1]) return null;
  const slot = extractSlotFromEmail(bodyText, subject);
  return { slot, code: codeMatch[1] };
}

/** True if this email matches the job's locked slot (match by slot only). */
function otpEmailMatchesJobSlot(parsed: ParsedOtpEmail, jobSlot?: string): boolean {
  if (jobSlot === undefined || jobSlot === "") return true;
  const slotNorm = String(parsed.slot).trim();
  const jobSlotNorm = String(jobSlot).trim();
  return slotNorm === jobSlotNorm;
}

/** True if message From/To match OTP sources: from IFTTT or rfitsms, to IT support. */
function otpEmailMatchesFromTo(headers: Array<{ name?: string | null; value?: string | null }>): boolean {
  const fromHeader = (headers.find((h) => (h.name || "").toLowerCase() === "from")?.value || "").toLowerCase();
  const toHeader = (headers.find((h) => (h.name || "").toLowerCase() === "to")?.value || "").toLowerCase();
  const fromOk = fromHeader.includes(OTP_EMAIL_FROM_IFTTT) || fromHeader.includes(OTP_EMAIL_FROM_RFITSMS);
  const toOk = !toHeader || toHeader.includes(OTP_EMAIL_TO_ITSUPPORT.toLowerCase());
  return fromOk && toOk;
}

export async function loadCredentials(): Promise<boolean> {
  try {
    const tokenPath = process.env.TOKEN_PATH || "token.json";

    if (!fs.existsSync(tokenPath)) {
      throw new Error(
        `Token file not found at ${tokenPath}. Please run the authentication setup first.`
      );
    }

    const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));

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

/**
 * Decode base64 encoded email body
 */
function decodeEmailBody(data: string): string {
  try {
    return Buffer.from(data, "base64").toString("utf-8");
  } catch (error) {
    return data;
  }
}

/**
 * Extract email body text from Gmail message
 */
function getEmailBodyText(message: any): string {
  try {
    const payload = message.payload;
    if (!payload) return "";

    let body = "";

    // Helper function to recursively extract from parts
    const extractFromParts = (parts: any[]): void => {
      for (const part of parts) {
        if (part.mimeType === "text/plain" || part.mimeType === "text/html") {
          if (part.body && part.body.data) {
            body += decodeEmailBody(part.body.data);
          }
        }
        // Recursively check nested parts
        if (part.parts) {
          extractFromParts(part.parts);
        }
      }
    };

    // Check if message has parts (multipart)
    if (payload.parts) {
      extractFromParts(payload.parts);
    } else if (payload.body && payload.body.data) {
      // Single part message
      body = decodeEmailBody(payload.body.data);
    }

    return body;
  } catch (error) {
    // Note: Cannot use await in non-async function, just return snippet
    return message.snippet || "";
  }
}

/**
 * Extract URLs from HTML content (including href attributes)
 */
function extractUrlsFromHtml(html: string): string[] {
  const urls: string[] = [];

  // Extract URLs from href attributes
  const hrefPattern = /href=["'](https?:\/\/[^"']+)["']/gi;
  let match;
  while ((match = hrefPattern.exec(html)) !== null) {
    urls.push(match[1]);
  }

  // Also extract plain URLs in text
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  while ((match = urlPattern.exec(html)) !== null) {
    urls.push(match[0]);
  }

  return urls;
}

export async function getVerificationCode(jobId?: string): Promise<string | null> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const jobContact = jobId ? getJobPhoneAndPort(jobId) : undefined;

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const listQuery = jobContact
      ? `from:${OTP_EMAIL_FROM_IFTTT} OR from:${OTP_EMAIL_FROM_RFITSMS}`
      : undefined;
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: jobContact ? 15 : 5,
      ...(listQuery && { q: listQuery }),
    });

    if (!res.data.messages) {
      await dualLogInfo("No new emails found.");
      return null;
    }

    for (const msg of res.data.messages) {
      if (!msg.id) continue;

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = email.data.payload?.headers || [];
      if (jobContact && !otpEmailMatchesFromTo(headers)) continue;

      const subjectHeader = headers.find((h: any) => h.name === "Subject");
      const subject = subjectHeader?.value || "";
      const emailBody = getEmailBodyText(email.data);
      const bodyText = emailBody || email.data.snippet || "";

      if (jobContact && (jobContact.phone || jobContact.port)) {
        const parsed = parseOtpEmailSenderSlotAndCode(bodyText, subject);
        if (parsed && otpEmailMatchesJobSlot(parsed, jobContact.port)) {
          await dualLogInfo(`Verification code for job ${jobId} (slot ${parsed.slot}): ${parsed.code}`);
          return parsed.code;
        }
        continue;
      }

      const codeMatch = bodyText.match(/\b\d{6,10}\b/);
      if (codeMatch) {
        await dualLogInfo("Code match:", codeMatch[0]);
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

/**
 * Get last 5 verification codes for Booking.com.
 * If jobId is provided and the job has a locked phone (and optional port), only codes from
 * emails matching that Sender + Slot are returned (PORT 9 SMS / IFTTT format).
 */
export async function getBookingVerificationCodes(jobId?: string): Promise<string[]> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const jobContact = jobId ? getJobPhoneAndPort(jobId) : undefined;

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // From: action@ifttt.com OR rfitsms@gmail.com; Subject e.g. "PORT 13 SMS"; To: itsupport@vnpsolutions.com
    const listQuery = `from:${OTP_EMAIL_FROM_IFTTT} OR from:${OTP_EMAIL_FROM_RFITSMS}`;
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 20,
      q: listQuery,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo("No OTP emails found (IFTTT or rfitsms).");
      return [];
    }

    await dualLogInfo(`Found ${res.data.messages.length} OTP emails (IFTTT / rfitsms)`);

    const codes: string[] = [];

    for (const msg of res.data.messages) {
      if (!msg.id || codes.length >= 5) continue;

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = email.data.payload?.headers || [];
      if (!otpEmailMatchesFromTo(headers)) continue;

      const subjectHeader = headers.find((h: any) => h.name === "Subject");
      const subject = subjectHeader?.value || "";
      const emailBody = getEmailBodyText(email.data);
      const snippet = email.data.snippet || "";
      const bodyText = emailBody || snippet;
      const searchText = `${subject} ${bodyText}`;

      if (jobContact && (jobContact.phone || jobContact.port)) {
        const parsed = parseOtpEmailSenderSlotAndCode(searchText, subject);
        if (parsed && otpEmailMatchesJobSlot(parsed, jobContact.port)) {
          if (parsed.code.length === 6 && !codes.includes(parsed.code)) {
            codes.push(parsed.code);
            await dualLogInfo(`Found verification code for job (slot ${parsed.slot}): ${parsed.code}`);
          }
        }
        continue;
      }

      const codePattern = /(?:Extranet|PIN)\s+code:\s*(\d{6})/i;
      const match = searchText.match(codePattern);
      if (match && match[1]) {
        const code = match[1];
        if (code.length === 6 && !codes.includes(code)) {
          codes.push(code);
          await dualLogInfo(`Found verification code: ${code}`);
        }
      }
    }

    await dualLogInfo(`Total verification codes found: ${codes.length}`, codes);
    return codes;
  } catch (error: any) {
    await dualLogError("Error fetching verification codes:", error.message);
    return [];
  }
}

/**
 * Get multiple verification codes from recent Booking.com verification emails (last 5 codes)
 * Returns an array of verification codes found in recent emails
 */
export async function getMultipleVerificationCodes(): Promise<string[]> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // IFTTT or rfitsms to IT support; Subject e.g. "to verify", "Extranet code", "PIN code", "PORT 13 SMS"
    const queries = [
      `from:${OTP_EMAIL_FROM_IFTTT} subject:"to verify"`,
      `from:${OTP_EMAIL_FROM_IFTTT} subject:"Extranet code"`,
      `from:${OTP_EMAIL_FROM_IFTTT} subject:"PIN code"`,
      `from:${OTP_EMAIL_FROM_IFTTT}`,
      `from:${OTP_EMAIL_FROM_RFITSMS} subject:"PORT"`,
      `from:${OTP_EMAIL_FROM_RFITSMS}`,
      'subject:"to verify"',
      'subject:"Extranet code"',
      'subject:"PIN code"',
      'subject:"PORT"',
    ];

    const codes: string[] = [];
    const processedMessageIds = new Set<string>();

    // Try each query pattern to find IFTTT verification emails
    for (const query of queries) {
      if (codes.length >= 5) {
        break;
      }

      try {
        const res = await gmail.users.messages.list({
          userId: "me",
          maxResults: 20, // Fetch more emails to ensure we get 5 codes
          q: query,
        });

        if (!res.data.messages || res.data.messages.length === 0) {
          continue;
        }

        await dualLogInfo(
          `Found ${res.data.messages.length} IFTTT emails matching: ${query}`
        );

        for (const msg of res.data.messages) {
          if (!msg.id || processedMessageIds.has(msg.id)) {
            continue;
          }

          // Stop if we already have 5 codes
          if (codes.length >= 5) {
            break;
          }

          processedMessageIds.add(msg.id);

          // Get full email body
          const email = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "full",
          });

          const headers = email.data.payload?.headers || [];
          if (!otpEmailMatchesFromTo(headers)) continue;

          const subjectHeader = headers.find((h: any) => h.name === "Subject");
          const subject = subjectHeader?.value || "";
          const emailBody = getEmailBodyText(email.data);
          const snippet = email.data.snippet || "";
          const bodyText = emailBody || snippet;
          const searchText = `${subject} ${bodyText}`;

          // Look for "Extranet code: XXXXXX" or "PIN code: XXXXXX" pattern
          // Pattern: "Extranet code: 166190" or "PIN code: 604317"
          // Can be in subject OR body
          const codePattern = /(?:Extranet|PIN)\s+code:\s*(\d{6})/i;
          const match = searchText.match(codePattern);

          if (match && match[1]) {
            const code = match[1];
            // Validate it's a 6-digit code and not already in our list
            if (code && code.length === 6 && !codes.includes(code)) {
              codes.push(code);
              await dualLogInfo(`Found verification code: ${code}`);
              if (codes.length >= 5) {
                break;
              }
            }
          }
        }
      } catch (queryError: any) {
        await dualLogError(
          `Error querying emails with pattern "${query}":`,
          queryError
        );
        continue;
      }
    }

    // If we still don't have 5 codes, try fallback: check all recent emails for Extranet/PIN code pattern
    if (codes.length < 5) {
      await dualLogInfo(
        `Only found ${codes.length} codes, trying fallback: checking all recent emails for Extranet/PIN code pattern`
      );

      const res = await gmail.users.messages.list({
        userId: "me",
        maxResults: 50, // Fetch even more emails
      });

      if (res.data.messages) {
        for (const msg of res.data.messages) {
          if (!msg.id || processedMessageIds.has(msg.id)) {
            continue;
          }

          if (codes.length >= 5) {
            break;
          }

          processedMessageIds.add(msg.id);

          try {
            const email = await gmail.users.messages.get({
              userId: "me",
              id: msg.id,
              format: "full",
            });

            // Get subject as well (code might be in subject)
            const headers = email.data.payload?.headers || [];
            const subjectHeader = headers.find(
              (h: any) => h.name === "Subject"
            );
            const subject = subjectHeader?.value || "";

            const emailBody = getEmailBodyText(email.data);
            const snippet = email.data.snippet || "";
            const bodyText = emailBody || snippet;

            // Combine subject and body to search for code
            const searchText = `${subject} ${bodyText}`;

            // Look for "Extranet code: XXXXXX" or "PIN code: XXXXXX" pattern
            const codePattern = /(?:Extranet|PIN)\s+code:\s*(\d{6})/i;
            const match = searchText.match(codePattern);
            if (match && match[1] && !codes.includes(match[1])) {
              codes.push(match[1]);
              await dualLogInfo(`Found verification code (fallback): ${match[1]}`);
            }
          } catch (emailError) {
            // Skip this email if there's an error
            continue;
          }
        }
      }
    }

    await dualLogInfo(
      `📧 Total verification codes found: ${codes.length}`,
      codes
    );
    return codes;
  } catch (error: any) {
    await dualLogError(
      "Error fetching multiple verification codes:",
      error.message
    );
    return [];
  }
}

/**
 * Get password reset URL from Booking.com email
 * Looks for email with subject "Booking.com - Reset your Booking.com password"
 * and extracts the reset URL from the email body
 */
export async function getPasswordResetUrl(): Promise<string | null> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    // Wait 22-25 seconds for email to arrive (following OTP pattern)
    const waitTime = 22000 + Math.random() * 3000; // 22-25 seconds
    await dualLogInfo(
      `Waiting ${Math.round(
        waitTime / 1000
      )}s for password reset email to arrive...`
    );
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Fetch latest 5 emails matching the subject
    await dualLogInfo("Fetching latest 5 password reset emails...");
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
      q: 'subject:"Booking.com - Reset your Booking.com password"',
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogError("No password reset emails found");
      return null;
    }

    await dualLogInfo(
      `Found ${res.data.messages.length} password reset email(s), using the latest one`
    );

    // Get the most recent email (first in the list is the latest)
    const messageId = res.data.messages[0].id;
    if (!messageId) {
      await dualLogError("Email ID not found");
      return null;
    }

    const email = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    // Get email subject to verify
    const headers = email.data.payload?.headers || [];
    const subjectHeader = headers.find((h: any) => h.name === "Subject");
    const subject = subjectHeader?.value || "";

    await dualLogInfo(`Email subject: ${subject}`);

    if (!subject.includes("Reset your Booking.com password")) {
      await dualLogError("Email subject doesn't match expected pattern");
      return null;
    }

    // Extract email body
    const emailBody = getEmailBodyText(email.data);
    await dualLogInfo("Found password reset email, extracting URL...");

    // Look for the password reset URL pattern
    // Pattern: https://account.booking.com/change-password-for-partners?token=...
    const urlPattern =
      /https?:\/\/account\.booking\.com\/change-password-for-partners\?token=[^\s<>"']+/i;

    // First try to extract URLs from HTML (including href attributes)
    const urlsFromHtml = extractUrlsFromHtml(emailBody);
    const htmlUrlMatch = urlsFromHtml.find((url) => {
      // Create a new regex for each test to avoid global flag issues
      return /https?:\/\/account\.booking\.com\/change-password-for-partners\?token=/i.test(
        url
      );
    });

    if (htmlUrlMatch) {
      const resetUrl = htmlUrlMatch.trim();
      await dualLogInfo(`Password reset URL found in HTML: ${resetUrl}`);
      return resetUrl;
    }

    // Also try direct pattern matching on body text
    const urlMatch = emailBody.match(urlPattern);
    if (urlMatch && urlMatch.length > 0) {
      const resetUrl = urlMatch[0].trim();
      await dualLogInfo(`Password reset URL found in body: ${resetUrl}`);
      return resetUrl;
    }

    // Also check snippet if full body extraction failed
    const snippet = email.data.snippet || "";
    const snippetUrlMatch = snippet.match(urlPattern);
    if (snippetUrlMatch && snippetUrlMatch.length > 0) {
      const resetUrl = snippetUrlMatch[0].trim();
      await dualLogInfo(`Password reset URL found in snippet: ${resetUrl}`);
      return resetUrl;
    }

    await dualLogError("Password reset URL not found in email body");
    return null;
  } catch (error: any) {
    await dualLogError("Error fetching password reset email:", error.message);
    return null;
  }
}
