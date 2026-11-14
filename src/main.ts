// First, so error reporting (Sentry, when SENTRY_DSN is set) is ready before anything else loads.
import './instrument';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { RedisIoAdapter } from './common/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);

  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connect();
  app.useWebSocketAdapter(ioAdapter);

  // API docs describe every internal route, so they are only served outside production.
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const config = new DocumentBuilder()
      .setTitle('Durob Al Hijra API')
      .setDescription('Production-grade API for Durob Al Hijra Intercity & Umrah Bus Booking System')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 4000;
  // Behind Nginx set HOST=127.0.0.1, so the API cannot be reached around the proxy.
  await app.listen(port, process.env.HOST || '0.0.0.0');
  console.log(`🚀 Durob Al Hijra Backend running on port ${port}${isProduction ? '' : ' [Swagger docs at /api/docs]'}`);
}
bootstrap();
