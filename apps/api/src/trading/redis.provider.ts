import { FactoryProvider } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { redisConfig } from '../config/redis.config';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Standalone ioredis client for trading-state storage (positions:open,
 * cooldowns, killswitch). Separate from BullMQ's internal connection to
 * avoid interfering with its blocking commands.
 */
export const redisClientProvider: FactoryProvider<Redis> = {
  provide: REDIS_CLIENT,
  useFactory: (cfg: ConfigType<typeof redisConfig>) =>
    new Redis({
      host: cfg.host,
      port: cfg.port,
      password: cfg.password || undefined,
      lazyConnect: false,
      maxRetriesPerRequest: null,
    }),
  inject: [redisConfig.KEY],
};
