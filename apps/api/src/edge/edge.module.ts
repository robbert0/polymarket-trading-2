import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DeribitModule } from '../deribit/deribit.module';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { EdgeService } from './edge.service';

@Module({
  imports: [HttpModule, DeribitModule, PolymarketModule],
  providers: [EdgeService],
  exports: [EdgeService],
})
export class EdgeModule {}