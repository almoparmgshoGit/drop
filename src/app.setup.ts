import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:8081'];

export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);
  const configuredOrigins = config.get<string>('CORS_ORIGINS');

  // Rate limits, login locks and the audit log all read req.ip, which behind a proxy is the proxy unless this is set.
  (app as NestExpressApplication).set('trust proxy', Number(config.get('TRUST_PROXY_HOPS') ?? 0));

  app.use(helmet());

  app.enableCors({
    origin: configuredOrigins ? configuredOrigins.split(',').map((origin) => origin.trim()) : DEV_ORIGINS,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
