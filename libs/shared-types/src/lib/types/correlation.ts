export interface PriceCorrelation {
  symbol: string;
  binancePrice: string | null;
  polymarketPrice: string | null;
  deribitPrice: number | null;
  deribitFunding: number | null;
  basisSpread: number | null;
  maxDivergencePercent: number | null;
  timestamp: number;
}

export interface MarketSnapshot {
  markets: Array<{
    slug: string;
    assetId: string;
    lastPrice: string | null;
    bestBid: string | null;
    bestAsk: string | null;
    spread: number | null;
  }>;
  btcPrice: string | null;
  ethPrice: string | null;
  timestamp: number;
}
