export interface OrderbookDepth {
  bestAsk?: number;
  bestAskSize?: number;
  bestBid?: number;
  bestBidSize?: number;
  spread?: number;
  fillableAmount?: number;
  effectivePrice?: number;
  executableEdge?: number;
  fillScore?: number;
}

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
  orderbook?: OrderbookDepth;
}

export interface ParsedBet {
  strike: number;
  expiry: string;
}