import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { oauth2Client } from "../config/google-config.js";

dotenv.config();

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

export async function getVerificationCode(): Promise<string | null> {
  try {
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
