import { registerAs } from '@nestjs/config';

export const postgresConfig = registerAs('postgres', () => ({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '', 10) || 5432,
  user: process.env.POSTGRES_USER ?? 'polymarket',
  password: process.env.POSTGRES_PASSWORD ?? 'polymarket',
  database: process.env.POSTGRES_DB ?? 'polymarket',
}));
