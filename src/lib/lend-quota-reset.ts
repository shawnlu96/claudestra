/** Extract only a future reset hint; absent zones use UTC, never the host's local zone. */
export function lendQuotaResetAt(reason: string, now: number): number | null {
  const english = reason.match(/try again at ([A-Za-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}) (\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+(UTC|GMT|[+-]\d{2}:?\d{2}))?/i);
  const iso = reason.match(/try again at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  const value = english ? `${english[1]} ${english[2]}, ${english[3]} ${english[4]}:${english[5]} ${english[6]} ${english[7] ?? 'UTC'}`
    : iso ? `${iso[1]}${/Z$|[+-]\d{2}:?\d{2}$/.test(iso[1]) ? '' : 'Z'}` : '';
  const reset = Date.parse(value);
  return Number.isFinite(reset) && reset > now ? reset : null;
}
