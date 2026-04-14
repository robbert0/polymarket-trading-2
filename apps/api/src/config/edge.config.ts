import { registerAs } from '@nestjs/config';

export const edgeConfig = registerAs('edge', () => ({
  arbitrageEdgeThreshold:
    parseFloat(process.env.ARBITRAGE_EDGE_THRESHOLD ?? '') || 0.08,
  bookRefreshMs:
    parseInt(process.env.BOOK_REFRESH_MS ?? '', 10) || 10_000,
  bookThrottleMs:
    parseInt(process.env.BOOK_THROTTLE_MS ?? '', 10) || 500,
}));
