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

export interface CryptoPricePayload {
  symbol: string;
  timestamp: number;
  value: number;
}

export interface EquityPricePayload {
  symbol: string;
  timestamp: number;
  value: number;
}

export interface CommentPayload {
  id: number;
  body: string;
  parent_entity_type: string;
  parent_entity_id: number;
  user_address: string;
  created_at: string;
  updated_at: string;
}

export type RtdsTopic =
  | 'activity'
  | 'comments'
  | 'crypto_prices'
  | 'crypto_prices_chainlink'
  | 'equity_prices';

export type RtdsType =
  | 'trades'
  | 'orders_matched'
  | 'comment_created'
  | 'comment_removed'
  | 'reaction_created'
  | 'reaction_removed';
