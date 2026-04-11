import { Injectable, Inject, HttpException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigType } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { polymarketConfig } from '../../config/polymarket.config';

@Injectable()
export class ClobRestService {
  private readonly logger = new Logger(ClobRestService.name);
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    @Inject(polymarketConfig.KEY)
    private readonly config: ConfigType<typeof polymarketConfig>,
  ) {
    this.baseUrl = this.config.clobApiUrl;
  }

  async getOrderBook(tokenId: string): Promise<unknown> {
    return this.request('/book', { token_id: tokenId });
  }

  async getPrice(tokenId: string, side: 'BUY' | 'SELL' = 'BUY'): Promise<unknown> {
    return this.request('/price', { token_id: tokenId, side });
  }

  async getPrices(tokenId: string): Promise<{ buy: unknown; sell: unknown }> {
    const [buy, sell] = await Promise.all([
      this.request('/price', { token_id: tokenId, side: 'BUY' }),
      this.request('/price', { token_id: tokenId, side: 'SELL' }),
    ]);
    return { buy, sell };
  }

  async getMidpoint(tokenId: string): Promise<unknown> {
    return this.request('/midpoint', { token_id: tokenId });
  }

  async getSpread(tokenId: string): Promise<unknown> {
    return this.request('/spread', { token_id: tokenId });
  }

  async getLastTradePrice(tokenId: string): Promise<unknown> {
    return this.request('/last-trade-price', { token_id: tokenId });
  }

  private async request(
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}${path}`, { params }),
      );
      return data;
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status || 502;
        const message = error.response?.data || error.message;
        this.logger.warn(
          `CLOB API ${path} returned ${status}: ${JSON.stringify(message)}`,
        );
        throw new HttpException(
          { source: 'clob', path, ...( typeof message === 'object' ? message : { error: message }) },
          status,
        );
      }
      throw error;
    }
  }
}
