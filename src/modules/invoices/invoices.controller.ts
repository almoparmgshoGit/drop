import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { InvoicesQuery, TaxReportQuery } from './invoices.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('Invoices')
@Controller('invoices')
@ApiBearerAuth()
export class InvoicesController {
  constructor(private invoices: InvoicesService) {}

  @Get()
  @RequirePermission('invoices.view')
  @ApiOperation({ summary: 'Invoices issued in a month, with collection figures' })
  list(@Req() req, @Query() query: InvoicesQuery) {
    return this.invoices.list(req.user, query);
  }

  @Get('tax-report')
  @RequirePermission('tax.view')
  @ApiOperation({ summary: 'VAT return figures for the whole company, by month or quarter' })
  taxReport(@Query() query: TaxReportQuery) {
    return this.invoices.taxReport(query);
  }

  // No permission: the service only answers for a booking the caller owns.
  @Get('mine/:bookingId')
  @ApiOperation({ summary: 'The invoice of one of the current customer bookings' })
  mine(@Req() req, @Param('bookingId') bookingId: string) {
    return this.invoices.printableForCustomer(req.user.userId, bookingId);
  }

  // Whoever takes a payment can hand over its receipt without being able to browse the register.
  @Get('bookings/:id')
  @RequirePermission('invoices.view', 'collections.collect')
  @ApiOperation({ summary: 'Everything needed to print the invoice of a booking' })
  printable(@Req() req, @Param('id') id: string) {
    return this.invoices.printable(req.user, id);
  }
}
