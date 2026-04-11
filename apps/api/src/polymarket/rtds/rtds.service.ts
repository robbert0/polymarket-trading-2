import { Injectable, Logger, OnModuleInit, OnApplicationShutdown, Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RealTimeDataClient,
  Message,
  ConnectionStatus,
  SubscriptionMessage,
} from '@polymarket/real-time-data-client';
import { polymarketConfig } from '../../config/polymarket.config';

@Injectable()
export class RtdsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RtdsService.name);
  private client: RealTimeDataClient;

  constructor(
    @Inject(polymarketConfig.KEY)
    private readonly config: ConfigType<typeof polymarketConfig>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.client = new RealTimeDataClient({
      host: this.config.rtdsUrl,
      autoReconnect: true,
      onConnect: () => {
        this.logger.log('Connected to Polymarket RTDS');
        this.subscribeDefaults();
      },
      onMessage: (_client: RealTimeDataClient, message: Message) => {
        this.handleMessage(message);
      },
      onStatusChange: (status: ConnectionStatus) => {
        this.logger.log(`RTDS connection status: ${status}`);
        this.eventEmitter.emit('polymarket.rtds.status', status);
      },
    });

    this.logger.log(`Connecting to RTDS at ${this.config.rtdsUrl}`);
    this.client.connect();
  }

  onApplicationShutdown(): void {
    this.logger.log('Disconnecting from RTDS');
    this.client?.disconnect();
  }

  subscribeTrades(filters?: { marketSlug?: string; eventSlug?: string }): void {
    const sub: SubscriptionMessage = {
      subscriptions: [
        {
          topic: 'activity',
          type: 'trades',
          ...(filters && { filters: JSON.stringify(filters) }),
        },
      ],
    };
    this.client.subscribe(sub);
    this.logger.log(`Subscribed to trades: ${JSON.stringify(filters || 'all')}`);
  }

  subscribeCryptoPrices(): void {
    this.client.subscribe({
      subscriptions: [{ topic: 'crypto_prices', type: 'crypto_prices' }],
    });
    this.logger.log('Subscribed to crypto prices');
  }

  subscribeEquityPrices(): void {
    this.client.subscribe({
      subscriptions: [{ topic: 'equity_prices', type: 'equity_prices' }],
    });
    this.logger.log('Subscribed to equity prices');
  }

  subscribeComments(parentEntityId?: number, parentEntityType?: string): void {
    const filters: Record<string, unknown> = {};
    if (parentEntityId) filters.parent_entity_id = parentEntityId;
    if (parentEntityType) filters.parent_entity_type = parentEntityType;

    this.client.subscribe({
      subscriptions: [
        {
          topic: 'comments',
          type: 'comment_created',
          ...(Object.keys(filters).length && { filters: JSON.stringify(filters) }),
        },
      ],
    });
    this.logger.log('Subscribed to comments');
  }

  unsubscribeTrades(filters?: { marketSlug?: string; eventSlug?: string }): void {
    this.client.unsubscribe({
      subscriptions: [
        {
          topic: 'activity',
          type: 'trades',
          ...(filters && { filters: JSON.stringify(filters) }),
        },
      ],
    });
  }

  getConnectionStatus(): string {
    return this.client ? 'connected' : 'disconnected';
  }

  private subscribeDefaults(): void {
    this.subscribeTrades();
  }

  private handleMessage(message: Message): void {
    const { topic, type } = message;

    switch (topic) {
      case 'activity':
        if (type === 'trades') {
          this.eventEmitter.emit('polymarket.trade', message.payload);
        } else if (type === 'orders_matched') {
          this.eventEmitter.emit('polymarket.order_matched', message.payload);
        }
        break;
      case 'crypto_prices':
      case 'crypto_prices_chainlink':
        this.eventEmitter.emit('polymarket.crypto_price', message.payload);
        break;
      case 'equity_prices':
        this.eventEmitter.emit('polymarket.equity_price', message.payload);
        break;
      case 'comments':
        this.eventEmitter.emit('polymarket.comment', {
          type,
          ...message.payload,
        });
        break;
      default:
        this.logger.debug(`Unhandled RTDS topic: ${topic}/${type}`);
    }
  }
}
