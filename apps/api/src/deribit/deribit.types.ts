export interface DeribitJsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface DeribitJsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  result?: unknown;
  params?: {
    channel: string;
    data: unknown;
  };
  error?: {
    code: number;
    message: string;
  };
}

export interface DeribitTickerData {
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
  stats: {
    volume: number;
    volume_usd: number;
    price_change: number;
    low: number;
    high: number;
  };
  timestamp: number;
  state: string;
}

export interface DeribitOptionData {
  instrument_name: string;
  underlying_price: number;
  mark_price: number;
  mark_iv: number;
  bid_iv: number;
  ask_iv: number;
  greeks: {
    delta: number;
    gamma: number;
    vega: number;
    theta: number;
    rho: number;
  };
  open_interest: number;
  stats: {
    volume: number;
    price_change: number;
  };
  timestamp: number;
}
