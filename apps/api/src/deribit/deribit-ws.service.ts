import {
  Injectable,
  Logger,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import { EVENTS } from '@polymarket-ws/shared-types';
import type { DeribitTicker, DeribitOption } from '@polymarket-ws/shared-types';
import type {
  DeribitJsonRpcRequest,
  DeribitJsonRpcResponse,
  DeribitTickerData,
  DeribitOptionData,
} from './deribit.types';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_S = 10;

@Injectable()
export class DeribitWsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DeribitWsService.name);
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private rpcId = 0;
  private readonly wsUrl: string;
  private readonly instruments: string[];
  private readonly dynamicInstruments = new Set<string>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.wsUrl = this.configService.get(
      'deribit.wsUrl',
      'wss://www.deribit.com/ws/api/v2',
    );
    this.instruments = this.configService.get('deribit.instruments', [
      'BTC-PERPETUAL',
      'ETH-PERPETUAL',
    ]);
  }

  onModuleInit(): void {
    this.connect();
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  getConnectionStatus(): string {
    return this.ws?.readyState === WebSocket.OPEN
      ? 'connected'
      : 'disconnected';
  }

  /** Dynamically subscribe to additional instruments (e.g., option tickers) */
  subscribeInstruments(instruments: string[]): void {
    const newInstruments = instruments.filter(
      (i) => !this.dynamicInstruments.has(i),
    );
    if (newInstruments.length === 0) return;

    for (const i of newInstruments) {
      this.dynamicInstruments.add(i);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      const channels = newInstruments.map((i) => `ticker.${i}.100ms`);
      this.send('public/subscribe', { channels });
      this.logger.log(
        `Dynamically subscribed to ${newInstruments.length} instruments`,
      );
    }
  }

  /** Unsubscribe from dynamically added instruments */
  unsubscribeInstruments(instruments: string[]): void {
    const toRemove = instruments.filter((i) => this.dynamicInstruments.has(i));
    if (toRemove.length === 0) return;

    for (const i of toRemove) {
      this.dynamicInstruments.delete(i);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      const channels = toRemove.map((i) => `ticker.${i}.100ms`);
      this.send('public/unsubscribe', { channels });
    }
  }

  private connect(): void {
    this.logger.log(
      `Connecting to Deribit WS (${this.instruments.length} instruments)`,
    );

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.logger.log('Connected to Deribit WebSocket');
      this.eventEmitter.emit(EVENTS.DERIBIT.STATUS, 'connected');
      this.setupHeartbeat();
      this.subscribe();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      this.logger.warn('Deribit WS disconnected');
      this.eventEmitter.emit(EVENTS.DERIBIT.STATUS, 'disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`Deribit WS error: ${err.message}`);
    });
  }

  private send(method: string, params: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg: DeribitJsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method,
      params,
    };
    this.ws.send(JSON.stringify(msg));
  }

  private setupHeartbeat(): void {
    this.send('public/set_heartbeat', { interval: HEARTBEAT_INTERVAL_S });
  }

  private subscribe(): void {
    const allInstruments = [
      ...this.instruments,
      ...this.dynamicInstruments,
    ];
    const channels = allInstruments.map((i) => `ticker.${i}.100ms`);
    this.send('public/subscribe', { channels });
    this.logger.log(
      `Subscribed to ${channels.length} channels (${this.instruments.length} fixed, ${this.dynamicInstruments.size} dynamic)`,
    );
  }

  private handleMessage(raw: string): void {
    try {
      const msg: DeribitJsonRpcResponse = JSON.parse(raw);

      if (msg.method === 'heartbeat') {
        if ((msg.params as unknown as { type: string })?.type === 'test_request') {
          this.send('public/test', {});
        }
        return;
      }

      if (msg.method === 'subscription' && msg.params) {
        this.handleSubscription(msg.params.channel, msg.params.data);
      }
    } catch {
      // ignore non-JSON
    }
  }

  private handleSubscription(channel: string, data: unknown): void {
    if (channel.startsWith('ticker.')) {
      const instrumentName = channel.replace('ticker.', '').replace('.100ms', '');

      if (this.isOption(instrumentName)) {
        this.handleOptionTicker(data as DeribitOptionData);
      } else {
        this.handlePerpetualTicker(data as DeribitTickerData);
      }
    }
  }

  private handlePerpetualTicker(data: DeribitTickerData): void {
    const ticker: DeribitTicker = {
      instrument_name: data.instrument_name,
      mark_price: data.mark_price,
      index_price: data.index_price,
      last_price: data.last_price,
      best_bid_price: data.best_bid_price,
      best_ask_price: data.best_ask_price,
      best_bid_amount: data.best_bid_amount,
      best_ask_amount: data.best_ask_amount,
      open_interest: data.open_interest,
      current_funding: data.current_funding,
      funding_8h: data.funding_8h,
      volume_24h: data.stats?.volume ?? 0,
      price_change_24h: data.stats?.price_change ?? 0,
      timestamp: data.timestamp,
      source: 'deribit',
    };

    this.eventEmitter.emit(EVENTS.DERIBIT.TICKER, ticker);
  }

  private handleOptionTicker(data: DeribitOptionData): void {
    const option: DeribitOption = {
      instrument_name: data.instrument_name,
      underlying_price: data.underlying_price,
      mark_price: data.mark_price,
      mark_iv: data.mark_iv,
      bid_iv: data.bid_iv,
      ask_iv: data.ask_iv,
      delta: data.greeks?.delta ?? 0,
      gamma: data.greeks?.gamma ?? 0,
      vega: data.greeks?.vega ?? 0,
      theta: data.greeks?.theta ?? 0,
      open_interest: data.open_interest,
      volume_24h: data.stats?.volume ?? 0,
      timestamp: data.timestamp,
      source: 'deribit',
    };

    this.eventEmitter.emit(EVENTS.DERIBIT.OPTIONS, option);
  }

  private isOption(instrumentName: string): boolean {
    return /\d{1,2}[A-Z]{3}\d{2,4}/.test(instrumentName);
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.logger.log(
      `Reconnecting to Deribit WS in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }
}
