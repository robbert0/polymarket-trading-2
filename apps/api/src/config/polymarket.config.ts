import { registerAs } from '@nestjs/config';

export const polymarketConfig = registerAs('polymarket', () => ({
  rtdsUrl:
    process.env.POLYMARKET_RTDS_URL || 'wss://ws-live-data.polymarket.com',
  clobWsUrl:
    process.env.POLYMARKET_CLOB_WS_URL ||
    'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  gammaApiUrl:
    process.env.POLYMARKET_GAMMA_API_URL || 'https://gamma-api.polymarket.com',
  clobApiUrl:
    process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
  defaultCryptoSymbols: (
    process.env.POLYMARKET_DEFAULT_CRYPTO_SYMBOLS || ''
  )
    .split(',')
    .filter(Boolean),
}));
