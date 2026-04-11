export interface EdgeComparison {
  marketId: string;
  label: string;
  strike: number;
  expiry: string;
  instrumentName: string;
  deribitProbability: number;
  polymarketProbability: number;
  difference: number;
  underlyingPrice: number;
  impliedVolatility: number;
  advice: 'BUY_YES' | 'BUY_NO' | 'NO_TRADE';
  edge: number;
  error?: string;
  slug?: string;
  volume?: number;
  liquidity?: number;
  timestamp: number;
}

export interface ParsedBet {
  strike: number;
  expiry: string;
}

export const ARBITRAGE_EDGE_THRESHOLD = 0.08;