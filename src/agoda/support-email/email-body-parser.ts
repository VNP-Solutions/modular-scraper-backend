/**
 * Parses the body of an Agoda Partner Support reply into structured fields.
 *
 * A typical reply looks like:
 *
 *   Case Id: 92752810
 *   PropertyID: 98433
 *   Property Name: The Westin Westminster
 *   City: Westminster (CO)
 *   Country: United States
 *   ...
 *   608820319
 *   590948995
 *   919720506
 *   ...
 *   This email belongs to the following accommodation partner Email: accounting@example.com
 */

import type { gmail_v1 } from "googleapis";
import type { ParsedSupportEmailBody } from "./support-email.types.js";

/** Reservation numbers Agoda lists are always plain 8-12 digit runs. */
const RESERVATION_ID_PATTERN = /^\d{8,12}$/;

/** Tags that imply a line break once markup is stripped. */
const BLOCK_TAG_PATTERN =
  /<\s*\/?\s*(?:br|p|div|tr|td|th|li|ul|ol|table|h[1-6])[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

function decodeEntities(input: string): string {
  return input
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_match, name: string) => {
      return NAMED_ENTITIES[name.toLowerCase()] ?? _match;
    })
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCharCode(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCharCode(parseInt(code, 16))
    );
}

/**
 * Strips markup while preserving the line structure the field parsers rely on.
 */
export function htmlToText(html: string): string {
  const withoutMarkup = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(BLOCK_TAG_PATTERN, "\n")
    .replace(/<[^>]+>/g, "");

  return normalizeText(decodeEntities(withoutMarkup));
}

function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodePart(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

interface CollectedBody {
  plain: string;
  html: string;
}

/**
 * Walks the MIME tree collecting every text/plain and text/html leaf.
 */
export function collectBodyParts(
  payload: gmail_v1.Schema$MessagePart | undefined,
  collected: CollectedBody = { plain: "", html: "" }
): CollectedBody {
  if (!payload) return collected;

  const mimeType = payload.mimeType ?? "";
  const data = payload.body?.data;

  // A part with a filename is an attachment, not body content.
  if (data && !payload.filename) {
    if (mimeType === "text/plain") {
      collected.plain += `${decodePart(data)}\n`;
    } else if (mimeType === "text/html") {
      collected.html += `${decodePart(data)}\n`;
    }
  }

  for (const part of payload.parts ?? []) {
    collectBodyParts(part, collected);
  }

  return collected;
}

/**
 * Prefers the text/plain alternative, falling back to de-tagged HTML.
 */
export function getEmailText(
  payload: gmail_v1.Schema$MessagePart | undefined
): string {
  const { plain, html } = collectBodyParts(payload);
  const plainText = normalizeText(plain);
  if (plainText) return plainText;
  return html ? htmlToText(html) : "";
}

function matchGroup(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * Pulls the reservation numbers Agoda lists as still owing a balance.
 *
 * They appear as bare numbers, one per line or space separated, so a line only
 * counts when every token on it is a reservation number. That keeps labelled
 * values such as `Case Id: 92752810` out of the result.
 */
function extractReservationIds(text: string, exclude: Set<string>): string[] {
  const ids = new Set<string>();

  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/[\s,;|]+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (!tokens.every((token) => RESERVATION_ID_PATTERN.test(token))) continue;

    for (const token of tokens) {
      if (!exclude.has(token)) ids.add(token);
    }
  }

  return [...ids];
}

export function parseSupportEmailBody(
  payload: gmail_v1.Schema$MessagePart | undefined
): ParsedSupportEmailBody {
  const text = getEmailText(payload);

  const caseId = matchGroup(text, /case\s*id\s*[:#-]?\s*(\d+)/i);
  const propertyId = matchGroup(text, /property\s*id\s*[:#-]?\s*(\d+)/i);

  const exclude = new Set<string>();
  if (caseId) exclude.add(caseId);
  if (propertyId) exclude.add(propertyId);

  return {
    caseId,
    propertyId,
    propertyName: matchGroup(text, /^\s*property\s*name\s*[:#-]?\s*(.+)$/im),
    city: matchGroup(text, /^\s*city\s*[:#-]?\s*(.+)$/im),
    country: matchGroup(text, /^\s*country\s*[:#-]?\s*(.+)$/im),
    reservationIds: extractReservationIds(text, exclude),
    partnerEmail: matchGroup(
      text,
      /accommodation\s+partner\s+email\s*[:#-]?\s*([^\s<>]+@[^\s<>]+)/i
    ),
    text,
  };
}

/**
 * Turns `Agoda <PartnerSupport@agoda.com>` into `partnersupport@agoda.com`.
 */
export function normalizeSenderAddress(fromHeader: string): string {
  const angled = /<([^>]+)>/.exec(fromHeader);
  const raw = angled?.[1] ?? fromHeader;
  return raw.trim().toLowerCase();
}

export function findHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string | null {
  const header = headers?.find(
    (candidate) => candidate.name?.toLowerCase() === name.toLowerCase()
  );
  return header?.value ?? null;
}
