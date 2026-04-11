import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';

const QUEUE_NAMES = [
  'raw-prices',
  'raw-trades',
  'raw-orderbook',
  'price-correlation',
  'market-snapshot',
  'edge-calculation',
];

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const PORT = parseInt(process.env.BULL_BOARD_PORT || '3100', 10);

const connection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
};

const queues = QUEUE_NAMES.map(
  (name) => new BullMQAdapter(new Queue(name, { connection })),
);

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/');

createBullBoard({
  queues,
  serverAdapter,
});

const app = express();
app.use('/', serverAdapter.getRouter());

app.listen(PORT, () => {
  console.log(
    `Bull Board running on http://localhost:${PORT} (Redis: ${REDIS_HOST}:${REDIS_PORT})`,
  );
});
