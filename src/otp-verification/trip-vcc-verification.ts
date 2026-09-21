import { google } from "googleapis";
import { dualLogError, dualLogInfo, dualLogWarn } from "../common/log-helper.js";
import { oauth2Client } from "../config/google-config.js";
import { loadCredentials } from "./email-verification-utils.js";

/**
 * Revealing VCC card details for the FIRST time in a given browser session
 * (the eBooking `scene=VIEW_VCC_CARD_DETAIL` identity check) sends a
 * numeric 6-digit email code — unlike the sign-in flow's magic link, there
 * is no link to click here, just a code to type into 6 on-page boxes.
 * Live-verified (2026-09-21) this challenge is per-browser-SESSION, not
 * per-order/per-page-load: once solved once, every subsequent VCC password
 * submission (any order, even after a full page reload) reveals the card
 * directly with no further OTP prompt for the rest of that session.
 *
 * Example email observed 2026-09-21:
 *   From: Trip.com <Lodgingsupport@trip.com>
 *   Subject: Your Trip eBooking verification code
 *   Body: "Here's your verification code: 062820" (plain text), rendered in
 *   HTML as a `<p style="letter-spacing:20px">062820</p>` block. Valid for
 *   10 minutes per the email's own text.
 */
const TRIP_VCC_OTP_EMAIL_FROM = "Lodgingsupport@trip.com";
const TRIP_VCC_OTP_EMAIL_SUBJECT = "Your Trip eBooking verification code";

/**
 * Strips HTML tags/entities down to plain text so the 6-digit code can be
 * located with a simple text regex regardless of the exact table/span
 * markup Trip.com wraps it in (which is templated marketing-email HTML,
 * not stable hand-written markup).
 */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function getHeaderValue(message: any, headerName: string): string {
  const headers = message?.payload?.headers as
    | Array<{ name?: string; value?: string }>
    | undefined;
  if (!headers) return "";
  const header = headers.find(
    (h) => h.name?.toLowerCase() === headerName.toLowerCase()
  );
  return header?.value ?? "";
}

function getEmailBodyHtml(message: any): string {
  try {
    const payload = message.payload;
    if (!payload) return "";

    let html = "";
    const walk = (parts: any[]) => {
      for (const part of parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          html += Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        if (part.parts) walk(part.parts);
      }
    };

    if (payload.parts) {
      walk(payload.parts);
    } else if (payload.mimeType === "text/html" && payload.body?.data) {
      html = Buffer.from(payload.body.data, "base64").toString("utf-8");
    }

    return html;
  } catch {
    return "";
  }
}

/**
 * Searches Gmail for up to `maxCodes` recent "Your Trip eBooking
 * verification code" emails and extracts each one's 6-digit code.
 *
 * Returned newest-first (matching Gmail's default list order), same
 * fallback pattern as `getTripSignInVerificationLinks` — multiple
 * candidates exist when more than one matching email landed within the
 * `sinceMs` window (e.g. a resend), each a fallback in case an earlier
 * code turns out to be expired/already used.
 *
 * @param sinceMs Only consider emails received at/after this timestamp —
 *   guards against picking up a stale code from an earlier/unrelated
 *   verification attempt.
 * @param maxCodes Maximum number of distinct codes to collect (default 3).
 * @param expectedRecipientPattern Optional regex (built from the masked
 *   email Trip.com's UI shows on the OTP screen itself, e.g.
 *   "ar***t@hyattfinance.com" — see `parseMaskedEmailPattern`) tested
 *   against each candidate email's real `To` header. This is a soft
 *   preference, not a hard filter: matching candidates are returned first,
 *   non-matching ones are kept as lower-priority fallbacks rather than
 *   dropped outright, since a parsing edge case here should never be able
 *   to hard-fail a job that would otherwise have succeeded. Guards against
 *   grabbing the wrong code when two properties' verification emails land
 *   in the same shared inbox within the same time window.
 */
export async function getTripVccVerificationCodes(
  sinceMs: number,
  maxCodes = 3,
  expectedRecipientPattern?: RegExp
): Promise<string[]> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      await dualLogError(
        "Trip VCC verification: failed to load Gmail credentials"
      );
      return [];
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 10,
      q: `from:${TRIP_VCC_OTP_EMAIL_FROM} subject:"${TRIP_VCC_OTP_EMAIL_SUBJECT}"`,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo("Trip VCC verification: no matching emails found yet");
      return [];
    }

    const matchedCodes: string[] = [];
    const unmatchedCodes: string[] = [];

    for (const msg of res.data.messages) {
      if (!msg.id) continue;

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const internalDate = Number(email.data.internalDate || 0);
      const fromHeader = getHeaderValue(email.data, "From");
      const toHeader = getHeaderValue(email.data, "To");
      const subjectHeader = getHeaderValue(email.data, "Subject");
      const snippet = email.data.snippet || "";

      if (internalDate && internalDate < sinceMs) {
        // Older than our trigger point — stale/unrelated email from a
        // previous attempt. Gmail returns newest-first, so we can stop here.
        await dualLogInfo(
          "Trip VCC verification: reached an email older than the trigger window, stopping scan",
          { messageId: msg.id, internalDate, sinceMs, fromHeader, toHeader }
        );
        break;
      }

      // Log every candidate email we actually inspect (not just the one we
      // end up picking) so it's clear which inbox message is being read.
      await dualLogInfo(
        "Trip VCC verification: inspecting candidate email",
        { messageId: msg.id, internalDate, fromHeader, toHeader, subjectHeader, snippet }
      );

      const html = getEmailBodyHtml(email.data);
      if (!html) {
        await dualLogWarn(
          "Trip VCC verification: email had no readable HTML body, skipping",
          { messageId: msg.id }
        );
        continue;
      }

      const text = stripHtmlToText(html);
      const match = text.match(/verification code:\s*(\d{6})/i);
      if (!match) {
        await dualLogWarn(
          "Trip VCC verification: could not find a 6-digit verification code in this email's body, skipping",
          { messageId: msg.id, snippet }
        );
        continue;
      }
      if (matchedCodes.includes(match[1]) || unmatchedCodes.includes(match[1])) {
        continue;
      }

      const recipientMatches =
        !expectedRecipientPattern || expectedRecipientPattern.test(toHeader);

      if (recipientMatches) {
        await dualLogInfo(
          "Trip VCC verification: found verification code candidate (recipient matched expected masked email)",
          { messageId: msg.id, internalDate, toHeader, code: match[1] }
        );
        matchedCodes.push(match[1]);
      } else {
        await dualLogWarn(
          "Trip VCC verification: found verification code but its recipient did NOT match the masked email shown on-page — keeping as a lower-priority fallback candidate",
          { messageId: msg.id, internalDate, toHeader, code: match[1] }
        );
        unmatchedCodes.push(match[1]);
      }
    }

    const codes = [...matchedCodes, ...unmatchedCodes].slice(0, maxCodes);

    if (codes.length === 0) {
      await dualLogInfo(
        "Trip VCC verification: no recent email contained a usable 6-digit code"
      );
    }

    return codes;
  } catch (error: any) {
    await dualLogError(
      "Trip VCC verification: error fetching verification email",
      error?.message
    );
    return [];
  }
}

/**
 * Convenience wrapper for callers that only want the single freshest code.
 * @see getTripVccVerificationCodes
 */
export async function getTripVccVerificationCode(
  sinceMs: number
): Promise<string | null> {
  const codes = await getTripVccVerificationCodes(sinceMs, 1);
  return codes[0] ?? null;
}
