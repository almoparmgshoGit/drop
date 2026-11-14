import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { ZatcaConfigDto, ZatcaDocumentsQuery, ZatcaEnabledDto, ZatcaOtpDto } from './zatca.dto';
import { ZatcaService } from './zatca.service';

@ApiTags('ZATCA e-invoicing')
@Controller('zatca')
@ApiBearerAuth()
export class ZatcaController {
  constructor(private zatca: ZatcaService) {}

  @Get('status')
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Phase-2 e-invoicing: environment, seller details, onboarding stage and queue counts. Never returns keys or secrets' })
  status() {
    return this.zatca.status();
  }

  @Put('config')
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Environment, seller address and certificate request details. Changing the environment restarts onboarding' })
  updateConfig(@Body() dto: ZatcaConfigDto) {
    return this.zatca.updateConfig(dto);
  }

  @Post('onboarding/compliance')
  @HttpCode(200)
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Step 1: new key pair and CSR, exchanged with the Fatoora portal OTP for a compliance certificate' })
  compliance(@Body() dto: ZatcaOtpDto) {
    return this.zatca.requestComplianceCsid(dto.code);
  }

  @Post('onboarding/checks')
  @HttpCode(200)
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Step 2: send the sample simplified invoice, credit note and debit note for the compliance checks' })
  checks() {
    return this.zatca.runComplianceChecks();
  }

  @Post('onboarding/production')
  @HttpCode(200)
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Step 3: exchange the passed compliance request for the production certificate' })
  production() {
    return this.zatca.requestProductionCsid();
  }

  @Put('enabled')
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Switch phase-2 signing and reporting on or off' })
  setEnabled(@Body() dto: ZatcaEnabledDto) {
    return this.zatca.setEnabled(dto.enabled);
  }

  @Post('sweep')
  @HttpCode(200)
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Run the signing and reporting pass now instead of waiting for the worker' })
  sweep() {
    return this.zatca.sweep();
  }

  @Get('documents')
  @RequirePermission('invoices.view', 'tax.view', 'settings.manage')
  @ApiOperation({ summary: 'Signed invoices and credit notes with their ZATCA reporting state' })
  documents(@Query() query: ZatcaDocumentsQuery) {
    return this.zatca.documents(query);
  }

  @Post('documents/:id/retry')
  @HttpCode(200)
  @RequirePermission('tax.view', 'settings.manage')
  @ApiOperation({ summary: 'Send a failed or rejected document again, as it was signed' })
  retry(@Param('id') id: string) {
    return this.zatca.retry(id);
  }

  @Get('documents/:id/xml')
  @RequirePermission('invoices.view', 'tax.view', 'settings.manage')
  @ApiOperation({ summary: 'The signed UBL XML of a document' })
  xml(@Param('id') id: string) {
    return this.zatca.xml(id);
  }
}
