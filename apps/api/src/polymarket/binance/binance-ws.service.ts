import { Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';

const DEFAULT_SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'dogeusdt', 'maticusdt'];
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

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

@Injectable()
export class BinanceWsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BinanceWsService.name);
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private symbols = DEFAULT_SYMBOLS;

  constructor(private readonly eventEmitter: EventEmitter2) {}

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
    return this.ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
  }

  private connect(): void {
    const streams = this.symbols.map((s) => `${s}@miniTicker`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    this.logger.log(`Connecting to Binance WS (${this.symbols.length} symbols)`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.logger.log('Connected to Binance WebSocket');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      this.logger.warn('Binance WS disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`Binance WS error: ${err.message}`);
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (!msg.data || msg.data.e !== '24hrMiniTicker') return;

      const d = msg.data;
      const price: CryptoPrice = {
        symbol: d.s,
        price: d.c,
        open: d.o,
        high: d.h,
        low: d.l,
        volume: d.v,
        quoteVolume: d.q,
        timestamp: d.E,
      };

      this.eventEmitter.emit('polymarket.crypto_price', price);
    } catch {
      // ignore non-JSON
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.logger.log(`Reconnecting to Binance WS in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }
}
