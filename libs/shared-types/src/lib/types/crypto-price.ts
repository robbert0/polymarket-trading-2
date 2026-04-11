export interface CryptoPrice {
  symbol: string;
  price: string;
  open: string;
  high: string;
  low: string;
  volume: string;
  quoteVolume: string;
  timestamp: number;
  source: 'binance' | 'polymarket' | 'deribit';
}
