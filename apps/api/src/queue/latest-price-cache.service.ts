import { Injectable } from '@nestjs/common';

interface Entry {
  price: string;
  timestamp: number;
}

/**
 * In-process staging cache for the latest price per (symbol, source).
 *
 * Previously lived in Redis under `latest-prices:{symbol}:{source}` hashes
 * with a 60s TTL. The BullMQ processors that write and read this data all
 * run in the same Node process, so Redis added network round-trips + a
 * 4× duplicated `LATEST_PRICES_PREFIX` constant for no benefit. Moving
 * in-process removes both.
 *
 * TTL is enforced lazily on read — matches the old Redis EXPIRE semantics
 * (readers skip stale entries; no background sweeper needed).
 *
 * NOTE on multi-process: if the API is ever clustered (pm2 / k8s replicas
 * > 1) this cache won't be shared across replicas. Correlation would only
 * fire when Binance + Deribit ticks land on the same replica. Swap back
 * to a Redis-backed impl at that point — the injection surface is stable.
 */
@Injectable()
export class LatestPriceCache {
  private readonly store = new Map<string, Entry>();
  private readonly ttlMs = 60_000;

  set(symbol: string, source: string, price: string, timestamp: number): void {
    this.store.set(this.key(symbol, source), { price, timestamp });
  }

  get(symbol: string, source: string): Entry | null {
    const k = this.key(symbol, source);
    const entry = this.store.get(k);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(k);
      return null;
    }
    return entry;
  }

  private key(symbol: string, source: string): string {
    return `${symbol}:${source}`;
  }
}
