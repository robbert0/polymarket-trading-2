import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RtdsService } from './rtds/rtds.service';
import { ClobWsService } from './clob-ws/clob-ws.service';
import { GammaService } from './gamma/gamma.service';
import { GammaController } from './gamma/gamma.controller';
import { ClobRestService } from './clob-rest/clob-rest.service';
import { ClobRestController } from './clob-rest/clob-rest.controller';
import { PolymarketGateway } from './gateway/polymarket.gateway';
import { SseController } from './sse/sse.controller';
import { BinanceWsService } from './binance/binance-ws.service';

@Module({
  imports: [HttpModule],
  controllers: [GammaController, ClobRestController, SseController],
  providers: [
    RtdsService,
    ClobWsService,
    BinanceWsService,
    GammaService,
    ClobRestService,
    PolymarketGateway,
  ],
  exports: [RtdsService, ClobWsService, BinanceWsService, GammaService, ClobRestService],
})
export class PolymarketModule {}
