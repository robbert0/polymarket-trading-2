export interface BookLevel {
  price: string;
  size: string;
}

export interface BookMessage {
  event_type: 'book';
  market: string;
  asset_id: string;
  timestamp: number;
  bids: BookLevel[];
  asks: BookLevel[];
  hash: string;
}

export interface PriceChangeMessage {
  event_type: 'price_change';
  asset_id: string;
  price: string;
  timestamp: number;
}

export interface LastTradePriceMessage {
  event_type: 'last_trade_price';
  asset_id: string;
  price: string;
  timestamp: number;
}
