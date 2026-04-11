import { Controller, Get, Param, Query } from '@nestjs/common';
import { GammaService } from './gamma.service';
import { MarketQueryDto } from '../dto/market-query.dto';

@Controller('markets')
export class GammaController {
  constructor(private readonly gammaService: GammaService) {}

  @Get()
  getMarkets(@Query() query: MarketQueryDto) {
    return this.gammaService.getMarkets(query as Record<string, unknown>);
  }

  @Get(':slug')
  getMarketBySlug(@Param('slug') slug: string) {
    return this.gammaService.getMarketBySlug(slug);
  }

  @Get('/events/list')
  getEvents(@Query() query: MarketQueryDto) {
    return this.gammaService.getEvents(query as Record<string, unknown>);
  }

  @Get('/events/:slug')
  getEventBySlug(@Param('slug') slug: string) {
    return this.gammaService.getEventBySlug(slug);
  }

  @Get('/search/:query')
  search(@Param('query') query: string) {
    return this.gammaService.search(query);
  }
}
