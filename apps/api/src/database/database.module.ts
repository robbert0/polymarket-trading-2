import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Pool } from 'pg';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { postgresConfig } from '../config/postgres.config';

export const PG_POOL = Symbol('PG_POOL');

// --- bootstrap runs migrations on startup -----------------------------------
@Injectable()
export class DatabaseBootstrap
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(DatabaseBootstrap.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    await this.ensureMigrationsTable();
    await this.runMigrations();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }

  private async ensureMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  private async runMigrations(): Promise<void> {
    // Webpack asset copy places SQL files at `dist/apps/api/database/migrations`
    // (see apps/api/webpack.config.js asset glob output).
    const dir = join(__dirname, 'database', 'migrations');
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    } catch (err) {
      this.logger.warn(
        `Migrations dir not found at ${dir}: ${(err as Error).message}`,
      );
      return;
    }

    const { rows } = await this.pool.query<{ name: string }>(
      'SELECT name FROM _migrations',
    );
    const applied = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      this.logger.log(`Running migration ${file}`);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations(name) VALUES ($1)', [
          file,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        this.logger.error(
          `Migration ${file} failed: ${(err as Error).message}`,
        );
        throw err;
      } finally {
        client.release();
      }
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (cfg: ConfigType<typeof postgresConfig>) =>
        new Pool({
          host: cfg.host,
          port: cfg.port,
          user: cfg.user,
          password: cfg.password,
          database: cfg.database,
          max: 10,
        }),
      inject: [postgresConfig.KEY],
    },
    DatabaseBootstrap,
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
