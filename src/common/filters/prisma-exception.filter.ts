import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const KNOWN_ERRORS: Record<string, { status: number; message: string }> = {
  P2002: { status: HttpStatus.CONFLICT, message: 'هذه القيمة مستخدمة مسبقًا' },
  P2003: { status: HttpStatus.CONFLICT, message: 'لا يمكن تنفيذ العملية لوجود بيانات مرتبطة' },
  P2014: { status: HttpStatus.CONFLICT, message: 'لا يمكن تنفيذ العملية لوجود بيانات مرتبطة' },
  P2025: { status: HttpStatus.NOT_FOUND, message: 'العنصر المطلوب غير موجود' },
};

/** PostgreSQL 18 reports a blocked delete as 23001 instead of 23503, and this Prisma version passes that code on unmapped. */
const isRestrictViolation = (exception: unknown) => exception instanceof Prisma.PrismaClientUnknownRequestError && exception.message.includes('code: "23001"');

@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError, Prisma.PrismaClientUnknownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError | Prisma.PrismaClientUnknownRequestError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const known = exception instanceof Prisma.PrismaClientKnownRequestError ? KNOWN_ERRORS[exception.code] : isRestrictViolation(exception) ? KNOWN_ERRORS.P2003 : undefined;
    const status = known?.status ?? (exception instanceof Prisma.PrismaClientValidationError ? HttpStatus.BAD_REQUEST : HttpStatus.INTERNAL_SERVER_ERROR);
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      console.error(exception);
    }
    response.status(status).json({
      statusCode: status,
      message: known?.message ?? (status === HttpStatus.BAD_REQUEST ? 'البيانات المرسلة غير صحيحة' : 'حدث خطأ في الخادم'),
    });
  }
}
