/**
 * Formats a UNIX millisecond timestamp as `DD-MM-YYYY HH:MM:SS` in
 * Europe/Amsterdam timezone, regardless of the browser's locale/TZ.
 * Returns '-' for null/undefined so callers don't need to guard.
 */
export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
