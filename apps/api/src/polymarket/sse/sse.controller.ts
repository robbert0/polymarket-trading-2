import { Controller, Logger, Param, Query, Req, Sse } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { ClobWsService } from '../clob-ws/clob-ws.service';
import { BookMessage, PriceChangeMessage, LastTradePriceMessage } from '../clob-ws/clob-ws.types';

interface MessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}

@Controller('sse')
export class SseController {
  private readonly logger = new Logger(SseController.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly clobWsService: ClobWsService,
  ) {}

  @Sse('trades')
  streamTrades(
    @Req() req: Request,
    @Query('market') market?: string,
    @Query('event') event?: string,
  ): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      const marketLower = market?.toLowerCase();
      const eventLower = event?.toLowerCase();
      const handler = (payload: Record<string, unknown>) => {
        if (marketLower && !(payload.slug as string)?.toLowerCase().includes(marketLower)) return;
        if (eventLower && !(payload.eventSlug as string)?.toLowerCase().includes(eventLower)) return;
        subscriber.next({ data: payload } as MessageEvent);
      };
      this.eventEmitter.on('polymarket.trade', handler);
      req.on('close', () => subscriber.complete());
      return () => this.eventEmitter.off('polymarket.trade', handler);
    });
  }

  @Sse('crypto-prices')
  streamCryptoPrices(@Req() req: Request): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      const handler = (payload: unknown) => {
        subscriber.next({ data: payload, type: 'crypto_price' } as MessageEvent);
      };
      this.eventEmitter.on('polymarket.crypto_price', handler);
      req.on('close', () => subscriber.complete());
      return () => this.eventEmitter.off('polymarket.crypto_price', handler);
    });
  }

  @Sse('market/:assetId')
  streamMarket(@Req() req: Request, @Param('assetId') assetId: string): Observable<MessageEvent> {
    const shortId = assetId.substring(0, 12);
    this.logger.log(`SSE market OPEN for ${shortId}...`);

    return new Observable((subscriber) => {
      let eventCount = 0;

      const bookHandler = (payload: BookMessage) => {
        if (payload.asset_id === assetId) {
          eventCount++;
          if (eventCount <= 3 || eventCount % 100 === 0) {
            this.logger.debug(`SSE ${shortId}: forwarding book event #${eventCount}`);
          }
          subscriber.next({ data: payload, type: 'book' } as MessageEvent);
        }
      };
      const priceHandler = (payload: PriceChangeMessage) => {
        if (payload.asset_id === assetId) {
          eventCount++;
          subscriber.next({ data: payload, type: 'price_change' } as MessageEvent);
        }
      };
      const lastTradeHandler = (payload: LastTradePriceMessage) => {
        if (payload.asset_id === assetId) {
          eventCount++;
          subscriber.next({ data: payload, type: 'last_trade_price' } as MessageEvent);
        }
      };

      this.eventEmitter.on('polymarket.book_update', bookHandler);
      this.eventEmitter.on('polymarket.price_change', priceHandler);
      this.eventEmitter.on('polymarket.last_trade_price', lastTradeHandler);

      this.clobWsService.subscribe([assetId]);

      const keepalive = setInterval(() => {
        subscriber.next({ data: '', type: 'keepalive' } as MessageEvent);
      }, 15_000);

      req.on('close', () => {
        this.logger.log(`SSE market CLOSE (req.close) for ${shortId}... after ${eventCount} events`);
        subscriber.complete();
      });

      return () => {
        this.logger.log(`SSE market TEARDOWN for ${shortId}... after ${eventCount} events, CLOB WS status: ${this.clobWsService.getConnectionStatus()}, subscribed: ${this.clobWsService.getSubscribedCount()}`);
        clearInterval(keepalive);
        this.eventEmitter.off('polymarket.book_update', bookHandler);
        this.eventEmitter.off('polymarket.price_change', priceHandler);
        this.eventEmitter.off('polymarket.last_trade_price', lastTradeHandler);
        this.clobWsService.unsubscribe([assetId]);
      };
    });
  }
}
