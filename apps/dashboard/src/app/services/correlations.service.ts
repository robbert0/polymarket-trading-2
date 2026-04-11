import { Injectable, NgZone } from '@angular/core';
import { Observable } from 'rxjs';

export interface PriceCorrelation {
  symbol: string;
  binancePrice: string | null;
  polymarketPrice: string | null;
  deribitPrice: number | null;
  deribitFunding: number | null;
  basisSpread: number | null;
  maxDivergencePercent: number | null;
  timestamp: number;
}

export interface EnrichedTrade {
  id: string;
  asset_id: string;
  market_slug: string;
  outcome: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  btcPriceAtTime: string | null;
  deribitIvAtTime: number | null;
  enrichedAt: number;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class CorrelationsService {
  private readonly baseUrl = '/api';

  constructor(private zone: NgZone) {}

  streamCorrelations(): Observable<{ type: string; data: PriceCorrelation | EnrichedTrade }> {
    return new Observable((subscriber) => {
      const es = new EventSource(`${this.baseUrl}/sse/correlations`);

      es.addEventListener('price_correlation', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next({ type: 'price_correlation', data: JSON.parse(event.data) });
        });
      });

      es.addEventListener('enriched_trade', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next({ type: 'enriched_trade', data: JSON.parse(event.data) });
        });
      });

      es.addEventListener('market_snapshot', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next({ type: 'market_snapshot', data: JSON.parse(event.data) });
        });
      });

      es.onerror = () => {
        this.zone.run(() => {
          subscriber.error(new Error('SSE connection lost'));
        });
      };

      return () => es.close();
    });
  }
}
