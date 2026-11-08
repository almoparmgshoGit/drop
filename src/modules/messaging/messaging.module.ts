import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Module, Param, Post, Put, Query, RawBodyRequest, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MessageDeliveryStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { Public, RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { MESSAGE_LANGUAGES, MessageLanguage } from '../../common/notification-catalog';
import { MANUAL_STATION_TYPES, ManualStationType } from '../../common/station-alert-rules';
import { StationAlertsService } from '../../common/services/station-alerts.service';
import { AudienceQueryDto, CampaignDto, SendCampaignDto } from './campaigns.dto';
import { CampaignsService } from './campaigns.service';
import { DeliveryWorkerService } from './delivery-worker.service';
import { WhatsAppAdminService } from './whatsapp-admin.service';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

class SetChannelsDto {
  @IsOptional() @IsBoolean() inApp?: boolean;
  @IsOptional() @IsBoolean() whatsapp?: boolean;
  @IsOptional() @IsBoolean() crewCanSend?: boolean;
}

class SubmitTemplateDto {
  @IsIn(MESSAGE_LANGUAGES) language: MessageLanguage;
}

class DeliveryLogQuery {
  @IsOptional() @IsEnum(MessageDeliveryStatus) status?: MessageDeliveryStatus;
  @IsOptional() @IsString() @MaxLength(60) event?: string;
  @IsOptional() @IsDateString() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

class UpdateRuleDto {
  @IsBoolean() isActive: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(240) minutes?: number;
}

class UpdateTripRuleDto {
  @ValidateIf((dto) => dto.isActive !== null) @IsBoolean() isActive: boolean | null;
}

class ManualAlertDto {
  @IsString() @IsNotEmpty() @MaxLength(200) stopKey: string;
  @IsIn(Object.keys(MANUAL_STATION_TYPES)) type: ManualStationType;
  @IsOptional() @IsInt() @Min(1) @Max(600) minutes?: number;
  @IsOptional() @trimmed() @IsString() @MaxLength(200) note?: string;
  @IsArray() @ArrayNotEmpty({ message: 'اختر قناة إرسال واحدة على الأقل' }) @IsIn(['IN_APP', 'WHATSAPP'], { each: true }) channels: ('IN_APP' | 'WHATSAPP')[];
}

class HistoryQuery {
  @IsString() @IsNotEmpty() @MaxLength(200) stopKey: string;
}

/** Reached by Meta, not by a person: it has no login, so the signature on the body is its proof. */
@ApiTags('WhatsApp webhook')
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private admin: WhatsAppAdminService) {}

  @Public()
  @SkipAudit()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  @ApiOperation({ summary: 'Meta confirms the webhook address with the agreed token' })
  async verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    // The challenge is echoed back, so it is held to digits and sent as plain text.
    if (mode !== 'subscribe' || !/^\d{1,40}$/.test(challenge ?? '') || !(await this.admin.isVerifyTokenValid(token))) throw new ForbiddenException();
    res.type('text/plain').send(challenge);
  }

  @Public()
  @SkipAudit()
  @Throttle({ default: { limit: 2000, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Delivery receipts and template decisions from Meta' })
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string, @Body() body: unknown) {
    if (!(await this.admin.isSignatureValid(req.rawBody, signature))) throw new ForbiddenException();
    await this.admin.applyWebhook(body);
    return { received: true };
  }
}

@ApiTags('WhatsApp')
@Controller('notifications')
@ApiBearerAuth()
export class WhatsAppAdminController {
  constructor(private admin: WhatsAppAdminService) {}

  @Get('whatsapp/status')
  @RequirePermission('notifications.manage', 'notifications.log')
  @ApiOperation({ summary: 'What is connected, with no secret values' })
  status(@Req() req: Request) {
    return this.admin.status(`${req.protocol}://${req.get('host')}/api/v1/webhooks/whatsapp`);
  }

  @Post('whatsapp/test')
  @HttpCode(200)
  @RequirePermission('notifications.manage')
  @ApiOperation({ summary: 'Read the sending number from Meta with the saved keys' })
  test() {
    return this.admin.test();
  }

  @Post('whatsapp/sync')
  @HttpCode(200)
  @RequirePermission('notifications.manage')
  @ApiOperation({ summary: "Refresh each template's approval state from Meta" })
  sync() {
    return this.admin.sync();
  }

  @Get('whatsapp/overview')
  @RequirePermission('notifications.manage')
  @ApiOperation({ summary: "Each customer action's WhatsApp state and 30-day delivery counts" })
  overview() {
    return this.admin.overview();
  }

  @Get('deliveries')
  @RequirePermission('notifications.log')
  @ApiOperation({ summary: 'WhatsApp send log, newest first, with masked phone numbers' })
  log(@Query() query: DeliveryLogQuery) {
    return this.admin.log(query);
  }

  @Put('templates/:event/channels')
  @RequirePermission('notifications.manage')
  @ApiOperation({ summary: "Turn one action's channels on or off" })
  setChannels(@Param('event') event: string, @Body() dto: SetChannelsDto) {
    return this.admin.setChannels(event, dto);
  }

  @Post('templates/:event/whatsapp')
  @RequirePermission('notifications.manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Send one action's wording to Meta for approval" })
  submit(@Param('event') event: string, @Body() dto: SubmitTemplateDto) {
    return this.admin.submit(event, dto.language);
  }
}

@ApiTags('Campaigns')
@Controller('notifications/campaigns')
@ApiBearerAuth()
@RequirePermission('notifications.campaigns')
export class CampaignsController {
  constructor(private campaigns: CampaignsService) {}

  @Get('options')
  @ApiOperation({ summary: 'What the audience filters can choose from' })
  options() {
    return this.campaigns.options();
  }

  @Post('audience')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'How many customers match these filters. Only a number leaves here, never who they are' })
  audience(@Body() dto: AudienceQueryDto) {
    return this.campaigns.audience(dto.filters, dto.couponId);
  }

  @Get()
  @ApiOperation({ summary: 'Recent messages to groups of customers' })
  list() {
    return this.campaigns.list();
  }

  @Post()
  @ApiOperation({ summary: 'Save a message as a draft' })
  create(@Req() req, @Body() dto: CampaignDto) {
    return this.campaigns.create(req.user, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One message with its filters' })
  get(@Param('id') id: string) {
    return this.campaigns.get(id);
  }

  @Get(':id/report')
  @ApiOperation({ summary: 'One message with how many each targeting choice reaches, and how far it got per channel' })
  report(@Param('id') id: string) {
    return this.campaigns.report(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Change a draft or a scheduled message, which returns it to a draft' })
  update(@Param('id') id: string, @Body() dto: CampaignDto) {
    return this.campaigns.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a draft' })
  remove(@Param('id') id: string) {
    return this.campaigns.remove(id);
  }

  @Post(':id/send')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send or schedule a draft to the audience count the sender confirmed' })
  send(@Req() req, @Param('id') id: string, @Body() dto: SendCampaignDto) {
    return this.campaigns.send(req.user, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a scheduled message' })
  cancel(@Param('id') id: string) {
    return this.campaigns.cancel(id);
  }
}

@ApiTags('Station alerts')
@Controller('station-alerts')
@ApiBearerAuth()
export class StationAlertsController {
  constructor(private stations: StationAlertsService) {}

  @Get('trips')
  @RequirePermission('notifications.stations')
  @ApiOperation({ summary: 'Trips on the road or about to leave' })
  trips() {
    return this.stations.activeTrips();
  }

  @Get('trips/:tripId')
  @RequirePermission('notifications.stations')
  @ApiOperation({ summary: "A trip's route with each stop's passenger counts and alerts" })
  trip(@Param('tripId') tripId: string) {
    return this.stations.tripView(tripId);
  }

  @Get('trips/:tripId/history')
  @RequirePermission('notifications.stations')
  @ApiOperation({ summary: 'What was announced about one stop' })
  history(@Param('tripId') tripId: string, @Query() query: HistoryQuery) {
    return this.stations.history(tripId, query.stopKey);
  }

  @Post('trips/:tripId/preview')
  @HttpCode(200)
  @RequirePermission('notifications.stations')
  @ApiOperation({ summary: 'The wording and head count of a manual alert' })
  preview(@Param('tripId') tripId: string, @Body() dto: ManualAlertDto) {
    return this.stations.preview(tripId, dto);
  }

  @Post('trips/:tripId/send')
  @HttpCode(200)
  @RequirePermission('notifications.stations')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a manual alert about one stop' })
  send(@Req() req, @Param('tripId') tripId: string, @Body() dto: ManualAlertDto) {
    return this.stations.sendManual(req.user, tripId, dto);
  }

  @Get('rules')
  @RequirePermission('notifications.stations', 'notifications.manage')
  @ApiOperation({ summary: 'Company-wide automatic alerts' })
  rules() {
    return this.stations.rules();
  }

  @Put('rules/:key')
  @RequirePermission('notifications.manage')
  @ApiOperation({ summary: 'Change a company-wide automatic alert' })
  updateRule(@Param('key') key: string, @Body() dto: UpdateRuleDto) {
    return this.stations.updateRule(key, dto);
  }

  @Put('trips/:tripId/rules/:key')
  @RequirePermission('notifications.stations')
  @ApiOperation({ summary: "Change an automatic alert for one trip; null returns it to the company's rule" })
  updateTripRule(@Param('tripId') tripId: string, @Param('key') key: string, @Body() dto: UpdateTripRuleDto) {
    return this.stations.updateTripRule(tripId, key, dto.isActive);
  }
}

@Module({
  controllers: [WhatsAppWebhookController, WhatsAppAdminController, CampaignsController, StationAlertsController],
  providers: [WhatsAppAdminService, CampaignsService, DeliveryWorkerService],
})
export class MessagingModule {}
