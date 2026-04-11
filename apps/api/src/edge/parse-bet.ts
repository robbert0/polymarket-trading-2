import type { ParsedBet } from '@polymarket-ws/shared-types';

const MONTHS: Record<string, string> = {
  january: 'JAN', february: 'FEB', march: 'MAR', april: 'APR',
  may: 'MAY', june: 'JUN', july: 'JUL', august: 'AUG',
  september: 'SEP', october: 'OCT', november: 'NOV', december: 'DEC',
  jan: 'JAN', feb: 'FEB', mar: 'MAR', apr: 'APR',
  jun: 'JUN', jul: 'JUL', aug: 'AUG', sep: 'SEP',
  oct: 'OCT', nov: 'NOV', dec: 'DEC',
};

/** Parse "Will the price of Bitcoin be above $X on DATE?" into strike and Deribit expiry code */
export function parseBet(question: string, endDate?: string): ParsedBet | null {
  const priceMatch =
    question.match(/\$([0-9,]+(?:\.\d+)?)\s*k?\b/i) ||
    question.match(/\$(\d+)k\b/i);
  if (!priceMatch) return null;

  let strike: number;
  const raw = priceMatch[1].replace(/,/g, '');
  if (priceMatch[0].toLowerCase().endsWith('k')) {
    strike = parseFloat(raw) * 1000;
  } else {
    strike = parseFloat(raw);
  }
  if (isNaN(strike) || strike < 1000) return null;

  const dateMatch = question.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/i,
  );
  if (!dateMatch) return null;

  const monthStr = MONTHS[dateMatch[1].toLowerCase()];
  const day = dateMatch[2];

  let year: string;
  if (dateMatch[3]) {
    year = dateMatch[3].slice(-2);
  } else if (endDate) {
    year = new Date(endDate).getFullYear().toString().slice(-2);
  } else {
    year = new Date().getFullYear().toString().slice(-2);
  }

  const expiry = `${day}${monthStr}${year}`;
  return { strike, expiry };
}