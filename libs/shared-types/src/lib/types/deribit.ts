export interface DeribitTicker {
  instrument_name: string;
  mark_price: number;
  index_price: number;
  last_price: number;
  best_bid_price: number;
  best_ask_price: number;
  best_bid_amount: number;
  best_ask_amount: number;
  open_interest: number;
  current_funding: number;
  funding_8h: number;
  volume_24h: number;
  price_change_24h: number;
  timestamp: number;
  source: 'deribit';
}

export interface DeribitOption {
  instrument_name: string;
  underlying_price: number;
  mark_price: number;
  mark_iv: number;
  bid_iv: number;
  ask_iv: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  open_interest: number;
  volume_24h: number;
  timestamp: number;
  source: 'deribit';
}
