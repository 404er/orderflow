import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BybitModule } from './bybit.module';

async function bootstrap() {
  Logger.log(new Date(), `Starting apps/bybit...`, 'Startup');

  const app = await NestFactory.create(BybitModule);

  setupExceptionCatchers();
  await app.listen(3000);
}

function setupExceptionCatchers() {
  process.on('uncaughtException', (e) => {
    Logger.error(new Date(), 'unhandled exception: ', e?.stack, e);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.on('unhandledRejection', (e: any, p) => {
    Logger.error(new Date(), 'unhandled rejection: ', e?.stack, e, p);
  });
}

bootstrap();
