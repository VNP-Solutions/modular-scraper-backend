/**
 * Trip.com's identity-verification screens each show a MASKED version of
 * the destination email address before the code/link is actually sent
 * (never the full address) — but using two different masking conventions,
 * both observed live (2026-09-21) for the exact same real recipient
 * address (`ardept@hyattfinance.com`):
 *
 *  - VCC card-details OTP screen (`scene=VIEW_VCC_CARD_DETAIL`):
 *    "ar***t@hyattfinance.com" — the `@` stays visible; only some
 *    local-part characters are hidden.
 *  - Sign-in identity-verification screen ("We've sent a verification
 *    link to ard****hyattfinance.com. Use this link to confirm it's
 *    really you."): "ard****hyattfinance.com" — the `@` itself is ALSO
 *    hidden inside the masked run, so no `@` appears in the text at all.
 *
 * Rather than special-casing either convention, {@link parseMaskedEmailPattern}
 * converts each run of 2+ asterisks into a `.*` regex wildcard and anchors
 * the rest — a wildcard simply consumes however many characters (including
 * a possible hidden `@`) turn out to be masked, so the same logic handles
 * both screens' output uniformly.
 *
 * The resulting pattern is intended as an extra correctness signal, not a
 * hard filter: Gmail's search operators can't match on a masked value (no
 * wildcard support for partial local-parts), so this is applied
 * client-side against each candidate email's real `To` header AFTER
 * fetching it via the existing from/subject/time-window search — letting
 * callers prefer/deprioritize candidates instead of ruling anything out
 * outright, so a parsing edge case here can never hard-fail a job that
 * would otherwise have succeeded.
 */
export function parseMaskedEmailPattern(pageText: string): RegExp | null {
  const match = pageText.match(
    /([A-Za-z0-9._-]{1,40}\*{2,}[A-Za-z0-9.@-]{1,60}\.[A-Za-z]{2,10})/
  );
  if (!match) return null;

  const token = match[1];
  const segments = token.split(/\*+/);
  if (segments.length < 2) return null;

  const escaped = segments
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  // Intentionally NOT anchored with ^/$: Gmail's `To` header can be a bare
  // address ("ardept@hyattfinance.com") or wrapped in a display name
  // ("John Doe <ardept@hyattfinance.com>") — an anchored pattern would
  // reject the latter even on a correct match. A substring test is still
  // plenty specific given the mask's visible prefix + suffix + full domain.
  try {
    return new RegExp(escaped, "i");
  } catch {
    return null;
  }
}
