/**
 * Agoda Email Sign-In Link Helper
 *
 * This module provides functionality to extract Agoda sign-in links from Gmail emails.
 *
 * Key Features:
 * - Searches for emails from Agoda with sign-in links
 * - Filters emails by sender (agoda.com, no-reply@account.agoda.com)
 * - Extracts verification/sign-in links from email content
 * - Handles both HTML and plain text email formats
 *
 * Usage:
 * ```typescript
 * import { getAgodaSignInLink } from './email-link-helper.js';
 *
 * const result = await getAgodaSignInLink();
 * if (result.signInLink) {
 *   console.log('Sign-in link:', result.signInLink);
 * }
 * ```
 *
 * Email Pattern Example:
 * From: Agoda <no-reply@account.agoda.com>
 * Subject: Your sign-in link
 * Content: Contains "sign in to YCS" and verification link
 */

import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { oauth2Client } from "../../config/google-config.js";

dotenv.config();

/**
 * Interface for Agoda sign-in link extraction result
 */
export interface AgodaSignInResult {
  signInLink: string | null;
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
    await dualLogInfo("Gmail credentials loaded successfully");
    return true;
  } catch (error) {
    await dualLogError("Error loading credentials:", error);
    return false;
  }
}

/**
 * Check if an email is from Agoda and contains sign-in link
 */
function isAgodaSignInEmail(headers: any[], snippet: string): boolean {
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

  // Check if it's a sign-in related email
  const isSignInEmail =
    subjectValue.includes("sign-in") ||
    subjectValue.includes("sign in") ||
    subjectValue.includes("verification") ||
    snippet.includes("sign in to YCS") ||
    snippet.includes("verification link");

  return isFromAgoda && isSignInEmail;
}

/**
 * Extract sign-in link from email body
 */
async function extractSignInLink(emailBody: string): Promise<string | null> {
  await dualLogInfo("🔍 Searching for sign-in link in email body...");

  // Look for various patterns of sign-in links
  const linkPatterns = [
    // URL in href attribute with token parameter (most specific)
    /href=["']([^"']*ycs\.agoda\.com[^"']*token[^"']*)/gi,
    // URL in href attribute for YCS domain
    /href=["']([^"']*ycs\.agoda\.com[^"']*)/gi,
    // URL in href attribute with sign/verify/auth keywords
    /href=["']([^"']*(?:sign|verify|auth)[^"']*)/gi,
    // Direct YCS domain URLs with token
    /(https?:\/\/[^\s<>"']*ycs\.agoda\.com[^\s<>"']*token[^\s<>"']*)/gi,
    // Direct YCS domain URLs
    /(https?:\/\/[^\s<>"']*ycs\.agoda\.com[^\s<>"']*)/gi,
    // Direct URL pattern with sign/verify/auth
    /(https?:\/\/[^\s<>"']+(?:sign|verify|auth)[^\s<>"']*)/gi,
    // General Agoda domain links
    /(https?:\/\/[^\s<>"']*agoda[^\s<>"']*)/gi,
  ];

  await dualLogInfo(`📧 Email body length: ${emailBody.length} characters`);

  // Log first 500 characters for debugging
  const preview = emailBody.substring(0, 500).replace(/\s+/g, " ");
  await dualLogInfo(`📄 Email preview: ${preview}...`);

  for (let i = 0; i < linkPatterns.length; i++) {
    const pattern = linkPatterns[i];
    await dualLogInfo(`🔎 Trying pattern ${i + 1}/${linkPatterns.length}`);

    const matches = emailBody.match(pattern);
    if (matches) {
      await dualLogInfo(
        `✅ Found ${matches.length} matches with pattern ${i + 1}`
      );

      for (const match of matches) {
        // Clean up the match (remove href= if present)
        let cleanLink = match.replace(/href=["']/, "");
        cleanLink = cleanLink.replace(/["']$/, "");
        cleanLink = cleanLink.trim();

        await dualLogInfo(`🔗 Checking link: ${cleanLink}`);

        const isAgodaPortalLink =
          cleanLink.includes("portal.agoda.com") ||
          cleanLink.includes("ycs.agoda.com");

        // Highest priority: portal/YCS links with token (the actual sign-in button)
        if (isAgodaPortalLink && cleanLink.includes("token")) {
          await dualLogInfo(
            `✅ Found Agoda portal sign-in link with token: ${cleanLink}`
          );
          return cleanLink;
        }

        // Second priority: portal/YCS links with login endpoint
        if (isAgodaPortalLink && cleanLink.includes("/login")) {
          await dualLogInfo(`✅ Found Agoda portal login link: ${cleanLink}`);
          return cleanLink;
        }

        // Third priority: portal/YCS domain links
        if (isAgodaPortalLink) {
          await dualLogInfo(`🔗 Found Agoda portal link (may be logo): ${cleanLink}`);
          // Don't return immediately, continue looking for better matches
        }

        // Fourth priority: Validate it looks like a sign-in link
        if (
          cleanLink.includes("sign") ||
          cleanLink.includes("verify") ||
          cleanLink.includes("auth") ||
          cleanLink.includes("login")
        ) {
          await dualLogInfo(`✅ Found sign-in link: ${cleanLink}`);
          return cleanLink;
        }

        // Last resort: If it's any Agoda link, log it for debugging
        if (cleanLink.includes("agoda")) {
          await dualLogInfo(
            `🔗 Found Agoda link (may be sign-in): ${cleanLink}`
          );
        }
      }
    } else {
      await dualLogInfo(`❌ No matches found with pattern ${i + 1}`);
    }
  }

  // If we get here, try to find any YCS link as a last resort
  await dualLogInfo(
    "🔄 No priority links found, searching for any YCS link..."
  );

  const fallbackPattern = /href=["']([^"']*ycs\.agoda\.com[^"']*)/gi;
  const fallbackMatches = emailBody.match(fallbackPattern);

  if (fallbackMatches && fallbackMatches.length > 0) {
    await dualLogInfo(
      `🔗 Found ${fallbackMatches.length} fallback links, selecting the last one (newest)`
    );

    // Take the last match (most recent/newest in email)
    const match = fallbackMatches[fallbackMatches.length - 1];
    let cleanLink = match.replace(/href=["']/, "");
    cleanLink = cleanLink.replace(/["']$/, "");
    cleanLink = cleanLink.trim();

    await dualLogInfo(`🔗 Selected newest fallback link: ${cleanLink}`);
    return cleanLink;
  }

  await dualLogError("❌ No sign-in link found in email body");
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
 * Get Agoda sign-in link from recent emails
 */
export async function getAgodaSignInLink(
  maxResults: number = 5
): Promise<AgodaSignInResult> {
  try {
    // Load credentials before making API calls
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Search for emails from Agoda with sign-in related content (sorted by newest first)
    const searchQuery =
      'from:agoda.com OR from:no-reply@account.agoda.com subject:(sign-in OR "sign in" OR verification)';

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: searchQuery,
      // Gmail returns messages in reverse chronological order (newest first) by default
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo("No Agoda sign-in emails found.");
      return {
        signInLink: null,
        emailFound: false,
      };
    }

    await dualLogInfo(
      `Found ${res.data.messages.length} potential Agoda emails (processing newest first)`
    );

    // Check each email for sign-in link (emails are already sorted newest first)
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

        // Verify this is actually an Agoda sign-in email
        if (!isAgodaSignInEmail(headers, snippet)) {
          continue;
        }

        const subjectHeader = headers.find(
          (h) => h.name?.toLowerCase() === "subject"
        );
        const dateHeader = headers.find(
          (h) => h.name?.toLowerCase() === "date"
        );

        await dualLogInfo(
          `Processing Agoda email: ${subjectHeader?.value || "Unknown subject"}`
        );

        if (dateHeader?.value) {
          await dualLogInfo(`📅 Email date: ${dateHeader.value}`);
        }

        // Get full email body
        const fullBody = getEmailBody(email.data.payload);

        // Extract sign-in link
        const signInLink = await extractSignInLink(fullBody);

        if (signInLink) {
          await dualLogInfo(`Sign-in link found: ${signInLink}`);
          return {
            signInLink,
            emailFound: true,
            emailSubject: subjectHeader?.value || undefined,
            emailDate: dateHeader?.value || undefined,
          };
        } else {
          await dualLogInfo(
            "No sign-in link found in this email, checking next..."
          );
        }
      } catch (emailError) {
        await dualLogError(`Error processing email ${msg.id}:`, emailError);
        continue;
      }
    }

    await dualLogInfo("No sign-in link found in any recent Agoda emails.");
    return {
      signInLink: null,
      emailFound: true,
    };
  } catch (error: any) {
    await dualLogError("Error fetching Agoda sign-in emails:", error.message);
    return {
      signInLink: null,
      emailFound: false,
    };
  }
}

/**
 * Example usage function for testing the Agoda sign-in link extraction
 */
export async function testAgodaEmailExtraction(): Promise<void> {
  try {
    await dualLogInfo("Testing Agoda email sign-in link extraction...");

    const result = await getAgodaSignInLink(10);

    if (result.signInLink) {
      await dualLogInfo("✅ Sign-in link found successfully!");
      await dualLogInfo(`Link: ${result.signInLink}`);
      if (result.emailSubject) {
        await dualLogInfo(`Email Subject: ${result.emailSubject}`);
      }
      if (result.emailDate) {
        await dualLogInfo(`Email Date: ${result.emailDate}`);
      }
    } else if (result.emailFound) {
      await dualLogInfo("📧 Agoda emails found but no sign-in link extracted");
    } else {
      await dualLogInfo("❌ No Agoda sign-in emails found");
    }
  } catch (error) {
    await dualLogError("Error testing Agoda email extraction:", error);
  }
}

/**
 * Legacy function for backward compatibility - get verification code
 * @deprecated Use getAgodaSignInLink instead
 */
export async function getVerificationCode(): Promise<string | null> {
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
