import { Controller, Get, Param, Query } from '@nestjs/common';
import { ClobRestService } from './clob-rest.service';

@Controller('clob')
export class ClobRestController {
  constructor(private readonly clobRestService: ClobRestService) {}

  @Get('book/:tokenId')
  getOrderBook(@Param('tokenId') tokenId: string) {
    return this.clobRestService.getOrderBook(tokenId);
  }

  @Get('price/:tokenId')
  getPrice(
    @Param('tokenId') tokenId: string,
    @Query('side') side?: 'BUY' | 'SELL',
  ) {
    if (side) {
      return this.clobRestService.getPrice(tokenId, side);
    }
    return this.clobRestService.getPrices(tokenId);
  }

  @Get('midpoint/:tokenId')
  getMidpoint(@Param('tokenId') tokenId: string) {
    return this.clobRestService.getMidpoint(tokenId);
  }

  @Get('spread/:tokenId')
  getSpread(@Param('tokenId') tokenId: string) {
    return this.clobRestService.getSpread(tokenId);
  }

  @Get('last-trade-price/:tokenId')
  getLastTradePrice(@Param('tokenId') tokenId: string) {
    return this.clobRestService.getLastTradePrice(tokenId);
  }
}
