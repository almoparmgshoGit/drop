import { Body, Controller, Get, HttpCode, Logger, Module, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { Public, SkipAudit } from '../../common/decorators/auth.decorators';
import { isErrorReportingEnabled, reportClientError } from '../../common/monitoring/error-reporter';
import { workerTicks } from '../../common/monitoring/worker-health';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';

const DB_TIMEOUT_MS = 3000;

class ClientErrorDto {
  @IsString() @MaxLength(2000) message: string;
  @IsOptional() @IsString() @MaxLength(8000) stack?: string;
  @IsOptional() @IsIn(['ios', 'android', 'web']) platform?: string;
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(80) screen?: string;
  @IsOptional() @IsBoolean() fatal?: boolean;
}

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

@ApiTags('Monitoring')
@Controller()
class MonitoringController {
  private readonly logger = new Logger('Health');

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  /**
   * For an external uptime monitor: 200 while the database (and Redis, when configured) answers, 503 otherwise.
   * Says nothing about data, only which part is down.
   */
  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Health check for uptime monitoring (database and Redis)' })
  async health(@Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    const db = await withTimeout(this.prisma.$queryRaw`SELECT 1`, DB_TIMEOUT_MS)
      .then(() => 'ok' as const)
      .catch((err) => {
        this.logger.error(`Database health check failed: ${(err as Error).message}`);
        return 'down' as const;
      });
    const redis = await this.redis.health();
    const healthy = db === 'ok' && redis !== 'down';
    res.status(healthy ? 200 : 503);
    res.setHeader('Cache-Control', 'no-store');
    return {
      status: healthy ? 'ok' : 'down',
      checks: { database: db, redis },
      workers: workerTicks(),
      uptimeSeconds: Math.round(process.uptime()),
      responseMs: Date.now() - started,
      time: new Date().toISOString(),
    };
  }

  /** The mobile app's own crashes, forwarded to Sentry by the server so the app carries no DSN or native SDK. */
  @Post('monitoring/client-errors')
  @Public()
  @SkipAudit()
  @HttpCode(202)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Error report from the mobile app (forwarded to Sentry when configured)' })
  clientError(@Body() dto: ClientErrorDto) {
    const forwarded = isErrorReportingEnabled() ? reportClientError(dto) : false;
    return { ok: true, forwarded };
  }
}

@Module({
  controllers: [MonitoringController],
})
export class MonitoringModule {}
