export interface TradePayload {
  id: string;
  asset_id: string;
  market_slug: string;
  event_slug: string;
  outcome: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  user: {
    name?: string;
    address: string;
    profile_image?: string;
  };
  transaction_hash: string;
  timestamp: number;
}

export interface EnrichedTrade extends TradePayload {
  btcPriceAtTime: string | null;
  deribitIvAtTime: number | null;
  enrichedAt: number;
}
