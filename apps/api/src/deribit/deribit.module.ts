import { Module } from '@nestjs/common';
import { DeribitWsService } from './deribit-ws.service';

@Module({
  providers: [DeribitWsService],
  exports: [DeribitWsService],
})
export class DeribitModule {}
