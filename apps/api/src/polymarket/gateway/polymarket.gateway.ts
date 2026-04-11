import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { RtdsService } from '../rtds/rtds.service';
import { ClobWsService } from '../clob-ws/clob-ws.service';
import { BookMessage, PriceChangeMessage, LastTradePriceMessage } from '../clob-ws/clob-ws.types';

@WebSocketGateway({
  namespace: '/polymarket',
  cors: { origin: '*' },
})
export class PolymarketGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(PolymarketGateway.name);

  @WebSocketServer()
  server: Server;

  private clientAssets = new Map<string, Set<string>>();

  constructor(
    private readonly rtdsService: RtdsService,
    private readonly clobWsService: ClobWsService,
  ) {}

  handleConnection(client: Socket): void {
    this.clientAssets.set(client.id, new Set());
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    const assets = this.clientAssets.get(client.id);
    if (assets) {
      this.clientAssets.delete(client.id);
    }
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe:trades')
  handleSubscribeTrades(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload?: { marketSlug?: string; eventSlug?: string },
  ): void {
    client.join('trades');
    this.rtdsService.subscribeTrades(payload);
    this.logger.debug(`Client ${client.id} subscribed to trades`);
  }

  @SubscribeMessage('subscribe:crypto_prices')
  handleSubscribeCryptoPrices(@ConnectedSocket() client: Socket): void {
    client.join('crypto_prices');
    this.logger.debug(`Client ${client.id} subscribed to crypto prices`);
  }

  @SubscribeMessage('subscribe:equity_prices')
  handleSubscribeEquityPrices(@ConnectedSocket() client: Socket): void {
    client.join('equity_prices');
    this.rtdsService.subscribeEquityPrices();
    this.logger.debug(`Client ${client.id} subscribed to equity prices`);
  }

  @SubscribeMessage('subscribe:comments')
  handleSubscribeComments(@ConnectedSocket() client: Socket): void {
    client.join('comments');
    this.rtdsService.subscribeComments();
    this.logger.debug(`Client ${client.id} subscribed to comments`);
  }

  @SubscribeMessage('subscribe:market')
  handleSubscribeMarket(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { assetIds: string[] },
  ): void {
    if (!payload?.assetIds?.length) return;

    const tracked = this.clientAssets.get(client.id);
    for (const id of payload.assetIds) {
      client.join(`market:${id}`);
      tracked?.add(id);
    }

    this.clobWsService.subscribe(payload.assetIds);
    this.logger.debug(
      `Client ${client.id} subscribed to ${payload.assetIds.length} market assets`,
    );
  }

  @SubscribeMessage('unsubscribe:market')
  handleUnsubscribeMarket(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { assetIds: string[] },
  ): void {
    if (!payload?.assetIds?.length) return;

    const tracked = this.clientAssets.get(client.id);
    for (const id of payload.assetIds) {
      client.leave(`market:${id}`);
      tracked?.delete(id);
    }
  }

  // --- Event handlers: RTDS events → Socket.io rooms ---

  @OnEvent('polymarket.trade')
  onTrade(payload: unknown): void {
    this.server.to('trades').emit('trade', payload);
  }

  @OnEvent('polymarket.crypto_price')
  onCryptoPrice(payload: unknown): void {
    this.server.to('crypto_prices').emit('crypto_price', payload);
  }

  @OnEvent('polymarket.equity_price')
  onEquityPrice(payload: unknown): void {
    this.server.to('equity_prices').emit('equity_price', payload);
  }

  @OnEvent('polymarket.comment')
  onComment(payload: unknown): void {
    this.server.to('comments').emit('comment', payload);
  }

  // --- Event handlers: CLOB WS events → Socket.io rooms ---

  @OnEvent('polymarket.book_update')
  onBookUpdate(payload: BookMessage): void {
    this.server.to(`market:${payload.asset_id}`).emit('book', payload);
  }

  @OnEvent('polymarket.price_change')
  onPriceChange(payload: PriceChangeMessage): void {
    this.server
      .to(`market:${payload.asset_id}`)
      .emit('price_change', payload);
  }

  @OnEvent('polymarket.last_trade_price')
  onLastTradePrice(payload: LastTradePriceMessage): void {
    this.server
      .to(`market:${payload.asset_id}`)
      .emit('last_trade_price', payload);
  }
}
