import { Injectable, Logger, OnApplicationShutdown, Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import { polymarketConfig } from '../../config/polymarket.config';
import { ClobWsMessage } from './clob-ws.types';

const MAX_ASSETS_PER_CONNECTION = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

@Injectable()
export class ClobWsService implements OnApplicationShutdown {
  private readonly logger = new Logger(ClobWsService.name);
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private subscribedAssets = new Set<string>();
  private refCounts = new Map<string, number>();
  private connected = false;
  private shuttingDown = false;

  constructor(
    @Inject(polymarketConfig.KEY)
    private readonly config: ConfigType<typeof polymarketConfig>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    this.cleanup();
  }

  subscribe(assetIds: string[]): void {
    const newIds: string[] = [];

    for (const id of assetIds) {
      const count = this.refCounts.get(id) || 0;
      this.refCounts.set(id, count + 1);
      this.logger.log(`subscribe ${id.substring(0, 12)}... refCount: ${count} -> ${count + 1}, ws: ${this.ws ? 'exists' : 'null'}, connected: ${this.connected}`);
      if (!this.subscribedAssets.has(id)) {
        newIds.push(id);
      }
    }

    if (newIds.length > 0) {
      if (this.subscribedAssets.size + newIds.length > MAX_ASSETS_PER_CONNECTION) {
        this.logger.warn(
          `Cannot subscribe to ${newIds.length} assets: would exceed ${MAX_ASSETS_PER_CONNECTION} limit (current: ${this.subscribedAssets.size})`,
        );
        return;
      }
      newIds.forEach((id) => this.subscribedAssets.add(id));
    }

    if (!this.ws) {
      this.logger.log(`No WS connection, connecting...`);
      this.connect();
    } else if (this.connected) {
      this.sendSubscription(assetIds);
    } else {
      this.logger.warn(`WS exists but not connected (readyState: ${this.ws.readyState}), cannot send subscription`);
    }
  }

  unsubscribe(assetIds: string[]): void {
    for (const id of assetIds) {
      const count = (this.refCounts.get(id) || 1) - 1;
      this.logger.log(`unsubscribe ${id.substring(0, 12)}... refCount: -> ${count}`);
      if (count <= 0) {
        this.refCounts.delete(id);
        this.subscribedAssets.delete(id);
      } else {
        this.refCounts.set(id, count);
      }
    }
    this.logger.log(`After unsubscribe: ${this.subscribedAssets.size} assets tracked, ${this.refCounts.size} refs`);
  }

  getConnectionStatus(): string {
    return this.connected ? 'connected' : 'disconnected';
  }

  getSubscribedCount(): number {
    return this.subscribedAssets.size;
  }

  private connect(): void {
    const url = this.config.clobWsUrl;
    this.logger.log(`Connecting to CLOB WS at ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.log('Connected to CLOB WebSocket');
      this.startHeartbeat();
      this.resubscribeAll();
      this.eventEmitter.emit('polymarket.clob_ws.status', 'connected');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.connected = false;
      this.stopHeartbeat();
      this.logger.warn(`CLOB WS disconnected: ${code} ${reason.toString()}`);
      this.eventEmitter.emit('polymarket.clob_ws.status', 'disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`CLOB WS error: ${err.message}`);
    });
  }

  private handleMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const msg of items) {
        if (msg.bids || msg.asks) {
          this.logger.debug(`Book update for asset ${msg.asset_id?.substring(0, 20)}...`);
          this.eventEmitter.emit('polymarket.book_update', msg);
        } else if (msg.price_changes) {
          for (const change of msg.price_changes) {
            this.eventEmitter.emit('polymarket.price_change', change);
          }
        } else if (msg.last_trade_price !== undefined) {
          this.eventEmitter.emit('polymarket.last_trade_price', msg);
        } else if (msg.tick_size !== undefined) {
          this.eventEmitter.emit('polymarket.tick_size_change', msg);
        }
      }
    } catch {
      // Might be a pong or non-JSON response
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('PING');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendSubscription(assetIds: string[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        assets_ids: assetIds,
        type: 'market',
      }),
    );
    this.logger.debug(`Sent CLOB subscription for ${assetIds.length} assets`);
  }

  private resubscribeAll(): void {
    if (this.subscribedAssets.size > 0) {
      this.sendSubscription([...this.subscribedAssets]);
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;

    if (this.subscribedAssets.size === 0) {
      this.logger.debug('No active subscriptions, skipping reconnect');
      this.ws = null;
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.logger.log(`Reconnecting to CLOB WS in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
