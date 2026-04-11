import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '@polymarket-ws/shared-types';
import { EdgeService } from '../../edge/edge.service';

@Processor(QUEUES.EDGE_CALCULATION, {
  concurrency: 1,
  limiter: { max: 1, duration: 10_000 },
})
export class EdgeCalculationProcessor extends WorkerHost {
  private readonly logger = new Logger(EdgeCalculationProcessor.name);

  constructor(private readonly edgeService: EdgeService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    try {
      await this.edgeService.refreshMarkets();
      this.logger.debug('Edge market discovery completed');
    } catch (err) {
      this.logger.error(`Edge market discovery failed: ${err.message}`);
      throw err;
    }
  }
}