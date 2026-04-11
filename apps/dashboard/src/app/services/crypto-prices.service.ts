import { Injectable, NgZone } from '@angular/core';
import { Observable } from 'rxjs';

export interface CryptoPrice {
  symbol: string;
  price: string;
  open: string;
  high: string;
  low: string;
  volume: string;
  quoteVolume: string;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class CryptoPricesService {
  private readonly baseUrl = '/api';

  constructor(private zone: NgZone) {}

  streamPrices(): Observable<CryptoPrice> {
    return new Observable((subscriber) => {
      const es = new EventSource(`${this.baseUrl}/sse/crypto-prices`);

      es.addEventListener('crypto_price', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next(JSON.parse(event.data));
        });
      });

      es.onmessage = (event) => {
        this.zone.run(() => {
          subscriber.next(JSON.parse(event.data));
        });
      };

      es.onerror = () => {
        this.zone.run(() => {
          subscriber.error(new Error('SSE connection lost'));
        });
      };

      return () => es.close();
    });
  }
}
