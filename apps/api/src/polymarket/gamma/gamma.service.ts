import { Injectable, Inject, HttpException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigType } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { polymarketConfig } from '../../config/polymarket.config';

@Injectable()
export class GammaService {
  private readonly logger = new Logger(GammaService.name);
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    @Inject(polymarketConfig.KEY)
    private readonly config: ConfigType<typeof polymarketConfig>,
  ) {
    this.baseUrl = this.config.gammaApiUrl;
  }

  async getMarkets(params?: Record<string, unknown>): Promise<unknown> {
    return this.request('/markets', params);
  }

  async getMarketBySlug(slug: string): Promise<unknown> {
    const data = await this.request('/markets', { slug });
    return Array.isArray(data) ? data[0] : data;
  }

  async getEvents(params?: Record<string, unknown>): Promise<unknown> {
    return this.request('/events', params);
  }

  async getEventBySlug(slug: string): Promise<unknown> {
    const data = await this.request('/events', { slug });
    return Array.isArray(data) ? data[0] : data;
  }

  async search(query: string): Promise<unknown> {
    return this.request('/markets', { _q: query });
  }

  private async request(
    path: string,
    params?: Record<string, unknown>,
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
          `Gamma API ${path} returned ${status}: ${JSON.stringify(message)}`,
        );
        throw new HttpException(
          { source: 'gamma', path, ...(typeof message === 'object' ? message : { error: message }) },
          status,
        );
      }
      throw error;
    }
  }
}
