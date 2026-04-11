export interface BookMessage {
  event_type: 'book';
  market: string;
  asset_id: string;
  timestamp: number;
  bids: [string, string][];
  asks: [string, string][];
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

export interface TickSizeChangeMessage {
  event_type: 'tick_size_change';
  asset_id: string;
  tick_size: string;
  timestamp: number;
}

export type ClobWsMessage =
  | BookMessage
  | PriceChangeMessage
  | LastTradePriceMessage
  | TickSizeChangeMessage;
