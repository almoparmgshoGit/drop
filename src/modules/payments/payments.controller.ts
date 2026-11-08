import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CancellationsService } from './cancellations.service';
import { CancellationsQuery, ExecuteRefundDto, MoveRefundToWalletDto, PaymentsQuery } from './payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Controller('payments')
@ApiBearerAuth()
export class PaymentsController {
  constructor(private payments: PaymentsService) {}

  @Get()
  @RequirePermission('payments.view')
  @ApiOperation({ summary: 'The register of charges and refunds in a month' })
  list(@Query() query: PaymentsQuery) {
    return this.payments.list(query);
  }

  @Get('export')
  @RequirePermission('payments.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="payments.csv"')
  @ApiOperation({ summary: 'Export the filtered register as CSV' })
  exportCsv(@Req() req, @Query() query: PaymentsQuery) {
    return this.payments.exportCsv(req.user.userId, query, req.ip);
  }
}

@ApiTags('Cancellations')
@Controller('cancellations')
@ApiBearerAuth()
export class CancellationsController {
  constructor(private cancellations: CancellationsService) {}

  @Get('counts')
  @RequirePermission('cancellations.review', 'cancellations.approve', 'refunds.execute')
  @ApiOperation({ summary: 'How many requests each tab holds' })
  counts() {
    return this.cancellations.counts();
  }

  @Get()
  @RequirePermission('cancellations.review', 'cancellations.approve', 'refunds.execute')
  @ApiOperation({ summary: 'Cancellation requests awaiting review, refunds under way, and finished ones' })
  list(@Query() query: CancellationsQuery) {
    return this.cancellations.list(query);
  }

  @Get(':bookingId')
  @RequirePermission('cancellations.review', 'cancellations.approve', 'refunds.execute')
  @ApiOperation({ summary: 'A request with its payment, the policy that applies and its refunds' })
  details(@Param('bookingId') bookingId: string) {
    return this.cancellations.details(bookingId);
  }

  @Post('refunds/:id/execute')
  @RequirePermission('refunds.execute')
  @ApiOperation({ summary: 'Confirm a refund was returned to the original payment method' })
  execute(@Req() req, @Param('id') id: string, @Body() dto: ExecuteRefundDto) {
    return this.cancellations.executeRefund(req.user, id, dto, req.ip);
  }

  @Post('refunds/:id/move-to-wallet')
  @RequirePermission('refunds.execute')
  @ApiOperation({ summary: 'Credit a refund that cannot reach the original method to the wallet instead' })
  moveToWallet(@Req() req, @Param('id') id: string, @Body() dto: MoveRefundToWalletDto) {
    return this.cancellations.moveToWallet(req.user, id, dto, req.ip);
  }
}
