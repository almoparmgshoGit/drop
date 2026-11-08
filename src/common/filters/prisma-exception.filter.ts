import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const KNOWN_ERRORS: Record<string, { status: number; message: string }> = {
  P2002: { status: HttpStatus.CONFLICT, message: 'هذه القيمة مستخدمة مسبقًا' },
  P2003: { status: HttpStatus.CONFLICT, message: 'لا يمكن تنفيذ العملية لوجود بيانات مرتبطة' },
  P2014: { status: HttpStatus.CONFLICT, message: 'لا يمكن تنفيذ العملية لوجود بيانات مرتبطة' },
  P2025: { status: HttpStatus.NOT_FOUND, message: 'العنصر المطلوب غير موجود' },
};

@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const known = exception instanceof Prisma.PrismaClientKnownRequestError ? KNOWN_ERRORS[exception.code] : undefined;
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
