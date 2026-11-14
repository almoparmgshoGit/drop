import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { reportError } from '../monitoring/error-reporter';
import { PrismaExceptionFilter } from './prisma-exception.filter';

const isPrismaError = (exception: unknown) =>
  exception instanceof Prisma.PrismaClientKnownRequestError || exception instanceof Prisma.PrismaClientValidationError || exception instanceof Prisma.PrismaClientUnknownRequestError;

/**
 * Answers exactly as Nest always has, and reports every server error (5xx) to Sentry when it is configured.
 * Database errors go to PrismaExceptionFilter whichever filter Nest picks first, so its answers never change.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly prismaFilter = new PrismaExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') return super.catch(exception, host);
    if (isPrismaError(exception)) return this.prismaFilter.catch(exception as never, host);
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) reportError(exception, host.switchToHttp().getRequest());
    return super.catch(exception, host);
  }
}
