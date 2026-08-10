/**
 * Agoda YCS Retrieval Email OTP Helper
 *
 * Extracts OTP (PIN) codes from Agoda payout/retrieval emails via Gmail API.
 *
 * Partner Portal OTP email structure (HTML):
 * - Subject: "Your PIN code for Partner Portal"
 * - OTP in styled cell: background-color:#f5f7fc, letter-spacing:8px
 * - Text: "Your one-time PIN code is:" followed by 6-digit code
 * - Footer contains Singapore postal code 049712 (NOT the OTP)
 */

import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { oauth2Client } from "../../config/google-config.js";

dotenv.config();

export interface YcsRetrievalOtpResult {
  otpCode: string | null;
  emailFound: boolean;
  emailSubject?: string;
  emailDate?: string;
}

const BLOCKED_OTP_VALUES = new Set([
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
  "049712", // Agoda Singapore postal code in email footer
  "200506", // Company registration number prefix in footer
]);

async function loadCredentials(): Promise<boolean> {
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
    await dualLogInfo(
      "Gmail credentials loaded successfully for YCS retrieval OTP extraction"
    );
    return true;
  } catch (error) {
    await dualLogError("Error loading credentials:", error);
    return false;
  }
}

function normalizeEmailText(emailBody: string): string {
  return emailBody
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/td>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

function getEmailBody(payload: any): { plain: string; html: string } {
  let plainText = "";
  let htmlText = "";

  function collectParts(node: any): void {
    if (node.body?.data) {
      const decoded = Buffer.from(node.body.data, "base64").toString("utf-8");
      if (node.mimeType === "text/plain") {
        plainText += decoded + "\n";
      } else if (node.mimeType === "text/html") {
        htmlText += decoded + "\n";
      }
    }

    if (node.parts && Array.isArray(node.parts)) {
      for (const part of node.parts) {
        collectParts(part);
      }
    }
  }

  collectParts(payload);

  return {
    plain: plainText.trim(),
    html: htmlText.trim(),
  };
}

function isSignInLinkEmail(subjectValue: string, snippet: string): boolean {
  return (
    subjectValue.includes("sign-in link") ||
    subjectValue.includes("sign in link") ||
    (subjectValue.includes("sign-in") && !subjectValue.includes("pin")) ||
    (subjectValue.includes("sign in") &&
      !subjectValue.includes("pin") &&
      !subjectValue.includes("passcode")) ||
    snippet.includes("sign in to") ||
    snippet.includes("verification link")
  );
}

function isOtpPinEmail(subjectValue: string, snippet: string): boolean {
  if (isSignInLinkEmail(subjectValue, snippet)) {
    return false;
  }

  return (
    subjectValue.includes("pin code for partner portal") ||
    subjectValue.includes("one-time passcode for ycs login") ||
    (subjectValue.includes("passcode") && subjectValue.includes("ycs")) ||
    snippet.includes("one-time PIN code is") ||
    snippet.includes("PIN code for YCS login") ||
    snippet.includes("PIN code for Partner Portal") ||
    snippet.includes("Please enter this PIN code in Partner Portal")
  );
}

function isYcsRetrievalOtpEmail(
  headers: any[],
  snippet: string,
  userEmail: string
): boolean {
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

  const isFromAgoda =
    fromValue.includes("no-reply@account.agoda.com") ||
    fromValue.includes("agoda");

  const isToUser = toValue.includes(userEmail.toLowerCase());

  return isFromAgoda && isToUser && isOtpPinEmail(subjectValue, snippet);
}

function isAddressOrFooterNumber(
  code: string,
  text: string,
  matchIndex: number
): boolean {
  const contextStart = Math.max(0, matchIndex - 60);
  const contextEnd = Math.min(text.length, matchIndex + code.length + 40);
  const context = text.substring(contextStart, contextEnd).toLowerCase();

  return (
    context.includes("singapore") ||
    context.includes("cecil street") ||
    context.includes("prudential tower") ||
    context.includes("registration number") ||
    context.includes("copyright") ||
    context.includes("postal")
  );
}

function validateOtpCode(
  code: string,
  text: string,
  matchIndex: number
): string | null {
  const cleanOtp = code.replace(/\s+/g, "");

  if (!/^\d{6}$/.test(cleanOtp)) {
    return null;
  }

  if (BLOCKED_OTP_VALUES.has(cleanOtp)) {
    return null;
  }

  if (isAddressOrFooterNumber(cleanOtp, text, matchIndex)) {
    return null;
  }

  return cleanOtp;
}

/**
 * Extract OTP using context-anchored patterns only (never generic 6-digit scan)
 */
function extractOtpFromText(text: string): string | null {
  const otpPatterns: RegExp[] = [
    // Partner Portal HTML OTP box (background-color:#f5f7fc cell)
    /background-color:#f5f7fc[\s\S]{0,400}?>(\s*\d{6}\s*)</gi,
    /letter-spacing:8px[\s\S]{0,200}?>(\s*\d{6}\s*)</gi,

    // Partner Portal text patterns (plain text + normalized HTML)
    /Your one-time PIN code is:\s*(\d{6})/gi,
    /one-time PIN code is:\s*(\d{6})/gi,
    /one-time PIN code is:[\s\S]{0,500}?(\d{6})/gi,
    /(\d{6})\s*Please enter this PIN code in Partner Portal/gi,

    // Legacy YCS
    /Your PIN code for YCS login[\s\S]{0,200}?(\d{6})/gi,
    /PIN code for YCS login[\s\S]{0,200}?(\d{6})/gi,
    /(\d{6})\s*Please enter this code on the YCS/gi,
  ];

  for (const pattern of otpPatterns) {
    for (const match of text.matchAll(pattern)) {
      const rawCode = match[1]?.trim();
      if (!rawCode) {
        continue;
      }

      const validOtp = validateOtpCode(
        rawCode,
        text,
        match.index ?? 0
      );

      if (validOtp) {
        return validOtp;
      }
    }
  }

  return null;
}

async function extractYcsRetrievalOtpCode(
  plainBody: string,
  htmlBody: string
): Promise<string | null> {
  await dualLogInfo(
    "🔍 Searching for OTP/PIN code in YCS retrieval email body..."
  );

  const normalizedHtml = htmlBody ? normalizeEmailText(htmlBody) : "";
  const bodies = [plainBody, htmlBody, normalizedHtml].filter(Boolean);

  for (const body of bodies) {
    await dualLogInfo(`📧 Trying extraction on body (${body.length} chars)`);
    const preview = body.substring(0, 300).replace(/\s+/g, " ");
    await dualLogInfo(`📄 Preview: ${preview}...`);

    const otp = extractOtpFromText(body);
    if (otp) {
      await dualLogInfo(`✅ Valid 6-digit OTP code found: ${otp}`);
      return otp;
    }
  }

  await dualLogInfo("❌ No valid OTP code found in email body");
  return null;
}

export async function getYcsRetrievalOtpCode(
  userEmail: string,
  maxResults: number = 5,
  referenceCode?: string
): Promise<YcsRetrievalOtpResult> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const searchQuery = `from:no-reply@account.agoda.com (subject:"PIN code for Partner Portal" OR subject:"One-time passcode for YCS login" OR subject:passcode) -subject:"sign-in" -subject:"sign in link" to:${userEmail}`;

    await dualLogInfo(
      `🔍 Searching for YCS retrieval OTP emails with query: ${searchQuery}`
    );

    if (referenceCode) {
      await dualLogInfo(
        `📋 Reference code from page (logging only): ${referenceCode}`
      );
    }

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: searchQuery,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo(`No YCS retrieval OTP emails found for ${userEmail}.`);
      return { otpCode: null, emailFound: false };
    }

    await dualLogInfo(
      `Found ${res.data.messages.length} potential OTP emails (newest first)`
    );

    for (let i = 0; i < res.data.messages.length; i++) {
      const msg = res.data.messages[i];
      await dualLogInfo(
        `📧 Processing email ${i + 1}/${res.data.messages.length}`
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
        const subjectHeader = headers.find(
          (h) => h.name?.toLowerCase() === "subject"
        );
        const subjectValue = (subjectHeader?.value || "").toLowerCase();

        if (isSignInLinkEmail(subjectValue, snippet)) {
          await dualLogInfo(
            `Skipping sign-in link email: ${subjectHeader?.value || "unknown"}`
          );
          continue;
        }

        if (!isYcsRetrievalOtpEmail(headers, snippet, userEmail)) {
          await dualLogInfo(
            `Skipping non-OTP email: ${subjectHeader?.value || "unknown"}`
          );
          continue;
        }

        const dateHeader = headers.find(
          (h) => h.name?.toLowerCase() === "date"
        );

        await dualLogInfo(
          `Processing OTP email: ${subjectHeader?.value || "Unknown subject"}`
        );

        if (dateHeader?.value) {
          await dualLogInfo(`📅 Email date: ${dateHeader.value}`);
        }

        const { plain, html } = getEmailBody(email.data.payload);
        const otpCode = await extractYcsRetrievalOtpCode(plain, html);

        if (otpCode) {
          await dualLogInfo(`✅ YCS Retrieval OTP code found: ${otpCode}`);
          return {
            otpCode,
            emailFound: true,
            emailSubject: subjectHeader?.value || undefined,
            emailDate: dateHeader?.value || undefined,
          };
        }

        await dualLogInfo("No OTP in this email, checking next...");
      } catch (emailError) {
        await dualLogError(`Error processing email ${msg.id}:`, emailError);
      }
    }

    await dualLogInfo("No OTP code found in any recent OTP emails.");
    return { otpCode: null, emailFound: true };
  } catch (error) {
    await dualLogError("Error fetching YCS retrieval OTP code:", error);
    return { otpCode: null, emailFound: false };
  }
}
