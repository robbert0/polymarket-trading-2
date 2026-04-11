import { registerAs } from '@nestjs/config';

export const deribitConfig = registerAs('deribit', () => ({
  wsUrl: process.env.DERIBIT_WS_URL || 'wss://www.deribit.com/ws/api/v2',
  instruments: (
    process.env.DERIBIT_INSTRUMENTS || 'BTC-PERPETUAL,ETH-PERPETUAL'
  )
    .split(',')
    .filter(Boolean),
}));
