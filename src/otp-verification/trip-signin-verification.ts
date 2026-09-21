import { google } from "googleapis";
import { dualLogError, dualLogInfo, dualLogWarn } from "../common/log-helper.js";
import { oauth2Client } from "../config/google-config.js";
import { loadCredentials } from "./email-verification-utils.js";

/**
 * Trip.com's "Email verification" option (an alternative to the SMS code on
 * the eBooking "Verify your identity" screen) sends a "Verify a recent
 * sign-in" email with a "Verify it's me" magic link — there is no numeric
 * code to type. Visiting that link in the same browser session completes
 * the verification.
 *
 * Example email observed 2026-09-21:
 *   From: Trip.com <Lodgingsupport@trip.com>
 *   Subject: Verify a recent sign-in
 *   Body contains an anchor with text "Verify it's me" linking to
 *   https://triplink.trip.com/forward/middlepages/channel/edm?targetUrl=...
 *   (a Trip.com tracking redirect that forwards to the real
 *   ebooking.trip.com/login/transfer?ticket=... URL).
 */
const TRIP_SIGNIN_EMAIL_FROM = "Lodgingsupport@trip.com";
const TRIP_SIGNIN_EMAIL_SUBJECT = "Verify a recent sign-in";
const VERIFY_LINK_TEXT = "Verify it's me";

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Finds the href of the anchor associated with `anchorText` by scanning
 * backwards from the text occurrence for the nearest preceding
 * `href="..."` attribute. Trip's email markup always places the opening
 * `<a href="...">` before the inner `<span>Verify it's me</span>` text, so
 * the closest preceding href belongs to that anchor.
 */
function extractLinkNearText(
  html: string,
  anchorText: string,
  searchWindow = 6000
): string | null {
  const idx = html.indexOf(anchorText);
  if (idx === -1) return null;

  const start = Math.max(0, idx - searchWindow);
  const before = html.slice(start, idx);
  const hrefMatches = [...before.matchAll(/href="([^"]+)"/g)];
  if (hrefMatches.length === 0) return null;

  const raw = hrefMatches[hrefMatches.length - 1][1];
  return decodeHtmlEntities(raw);
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
 * Searches Gmail for up to `maxLinks` recent "Verify a recent sign-in"
 * emails from Trip.com and extracts each one's "Verify it's me" link.
 *
 * Returned in newest-first order (matching Gmail's default list order), so
 * callers that try candidates in sequence attempt the freshest link first.
 *
 * @param sinceMs Only consider emails received at/after this timestamp —
 *   guards against picking up a stale email from an earlier/unrelated
 *   verification attempt when multiple people or jobs could trigger this
 *   same email around the same time.
 * @param maxLinks Maximum number of distinct links to collect (default 3).
 *   Multiple candidates exist when more than one matching email landed
 *   within the `sinceMs` window (e.g. a resend, or a stale-but-still-fresh
 *   email from a near-simultaneous attempt) — each is a fallback in case an
 *   earlier link turns out to be expired/already used.
 * @param expectedRecipientPattern Optional regex (built from the masked
 *   email Trip.com's UI shows on the verification screen itself, e.g.
 *   "ard****hyattfinance.com" — see `parseMaskedEmailPattern`) tested
 *   against each candidate email's real `To` header. This is a soft
 *   preference, not a hard filter: matching candidates are returned first,
 *   non-matching ones are kept as lower-priority fallbacks rather than
 *   dropped outright, since a parsing edge case here should never be able
 *   to hard-fail a job that would otherwise have succeeded. Guards against
 *   grabbing the wrong email when two properties' verification emails land
 *   in the same shared inbox within the same time window.
 */
export async function getTripSignInVerificationLinks(
  sinceMs: number,
  maxLinks = 3,
  expectedRecipientPattern?: RegExp
): Promise<string[]> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      await dualLogError(
        "Trip sign-in verification: failed to load Gmail credentials"
      );
      return [];
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 10,
      q: `from:${TRIP_SIGNIN_EMAIL_FROM} subject:"${TRIP_SIGNIN_EMAIL_SUBJECT}"`,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      await dualLogInfo(
        "Trip sign-in verification: no matching emails found yet"
      );
      return [];
    }

    const matchedLinks: string[] = [];
    const unmatchedLinks: string[] = [];

    for (const msg of res.data.messages) {
      if (!msg.id) continue;

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const internalDate = Number(email.data.internalDate || 0);
      if (internalDate && internalDate < sinceMs) {
        // Older than our trigger point — stale/unrelated email from a
        // previous attempt. Gmail returns newest-first, so we can stop here.
        break;
      }

      const html = getEmailBodyHtml(email.data);
      if (!html) continue;

      const link = extractLinkNearText(html, VERIFY_LINK_TEXT);
      if (!link || matchedLinks.includes(link) || unmatchedLinks.includes(link)) {
        continue;
      }

      const toHeader = getHeaderValue(email.data, "To");
      const recipientMatches =
        !expectedRecipientPattern || expectedRecipientPattern.test(toHeader);

      if (recipientMatches) {
        await dualLogInfo(
          "Trip sign-in verification: found verification link candidate (recipient matched expected masked email)",
          { messageId: msg.id, internalDate, toHeader }
        );
        matchedLinks.push(link);
      } else {
        await dualLogWarn(
          "Trip sign-in verification: found verification link but its recipient did NOT match the masked email shown on-page — keeping as a lower-priority fallback candidate",
          { messageId: msg.id, internalDate, toHeader }
        );
        unmatchedLinks.push(link);
      }
    }

    const links = [...matchedLinks, ...unmatchedLinks].slice(0, maxLinks);

    if (links.length === 0) {
      await dualLogInfo(
        "Trip sign-in verification: no recent email contained a usable verification link"
      );
    }

    return links;
  } catch (error: any) {
    await dualLogError(
      "Trip sign-in verification: error fetching verification email",
      error?.message
    );
    return [];
  }
}

/**
 * Convenience wrapper for callers that only want the single freshest link.
 * @see getTripSignInVerificationLinks
 */
export async function getTripSignInVerificationLink(
  sinceMs: number
): Promise<string | null> {
  const links = await getTripSignInVerificationLinks(sinceMs, 1);
  return links[0] ?? null;
}
