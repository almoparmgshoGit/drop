import { Controller, Get, Post, Put, Patch, Delete, Param, Body, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BusAccountsService } from './bus-accounts.service';
import {
  CreateBusDto,
  CreateBusOfficeDto,
  CreateDriverDto,
  CreateOfficePaymentDto,
  StatementQuery,
  UpdateBusDto,
  UpdateBusOfficeDto,
  UpdateDriverDto,
  UpdateTripCostDto,
  VoidOfficePaymentDto,
} from './buses.dto';
import { BusesService } from './buses.service';
import { CreateMaintenanceDto, UpdateMaintenanceDto } from './bus-maintenance.dto';
import { BusMaintenanceService } from './bus-maintenance.service';
import { DriversService } from './drivers.service';
import { RequirePermission } from '../../common/decorators/auth.decorators';

@ApiTags('Buses')
@Controller('buses')
@ApiBearerAuth()
export class BusesController {
  constructor(
    private busesService: BusesService,
    private maintenanceService: BusMaintenanceService,
  ) {}

  @Get()
  @RequirePermission('buses.view', 'trips.manage')
  @ApiOperation({ summary: 'Get all buses' })
  async getAllBuses() {
    return this.busesService.getAllBuses();
  }

  @Get(':id/maintenance')
  @RequirePermission('buses.view')
  @ApiOperation({ summary: "The bus's maintenance log, breakdown reports included" })
  async maintenance(@Param('id') id: string) {
    return this.maintenanceService.list(id);
  }

  @Post(':id/maintenance')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Add a maintenance entry to a bus' })
  async addMaintenance(@Req() req, @Param('id') id: string, @Body() dto: CreateMaintenanceDto) {
    return this.maintenanceService.create(id, req.user.userId, dto);
  }

  @Patch('maintenance/:logId')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Edit a maintenance entry (status, cost, description, dates)' })
  async updateMaintenance(@Param('logId') logId: string, @Body() dto: UpdateMaintenanceDto) {
    return this.maintenanceService.update(logId, dto);
  }

  @Delete('maintenance/:logId')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Delete a maintenance entry' })
  async deleteMaintenance(@Param('logId') logId: string) {
    return this.maintenanceService.remove(logId);
  }

  @Get(':id')
  @RequirePermission('buses.view')
  @ApiOperation({ summary: 'Get bus by ID' })
  async getBusById(@Param('id') id: string) {
    return this.busesService.getBusById(id);
  }

  @Post()
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Create new bus' })
  async createBus(@Body() dto: CreateBusDto) {
    return this.busesService.createBus(dto);
  }

  @Put(':id')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Update bus' })
  async updateBus(@Param('id') id: string, @Body() dto: UpdateBusDto) {
    return this.busesService.updateBus(id, dto);
  }

  @Delete(':id')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Delete bus' })
  async deleteBus(@Param('id') id: string) {
    return this.busesService.deleteBus(id);
  }
}

@ApiTags('Drivers')
@Controller('drivers')
@ApiBearerAuth()
export class DriversController {
  constructor(private drivers: DriversService) {}

  @Get()
  @RequirePermission('buses.view')
  @ApiOperation({ summary: 'Driver registry with iqama, license and current trip' })
  list() {
    return this.drivers.list();
  }

  @Post()
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Add a driver and their app login' })
  create(@Req() req, @Body() dto: CreateDriverDto) {
    return this.drivers.create(req.user, dto);
  }

  @Patch(':id')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Edit a driver, reset their password, or stop assigning them' })
  update(@Req() req, @Param('id') id: string, @Body() dto: UpdateDriverDto) {
    return this.drivers.update(req.user, id, dto);
  }
}

@ApiTags('Bus offices')
@Controller('bus-offices')
@ApiBearerAuth()
export class BusOfficesController {
  constructor(private accounts: BusAccountsService) {}

  @Get()
  @RequirePermission('buses.view', 'buses.rates')
  @ApiOperation({ summary: 'Bus rental offices; contracts and rates need buses.rates' })
  list(@Req() req) {
    return this.accounts.listOffices(req.user);
  }

  @Post()
  @RequirePermission('buses.accounts')
  @ApiOperation({ summary: 'Add a bus rental office with its rate table' })
  create(@Body() dto: CreateBusOfficeDto) {
    return this.accounts.createOffice(dto);
  }

  @Patch('trips/:tripId/cost')
  @RequirePermission('buses.accounts')
  @ApiOperation({ summary: "Set a trip's bus rent and the expenses deducted from it" })
  updateTripCost(@Param('tripId') tripId: string, @Body() dto: UpdateTripCostDto) {
    return this.accounts.updateTripCost(tripId, dto);
  }

  @Post('payments/:paymentId/void')
  @RequirePermission('buses.accounts')
  @ApiOperation({ summary: 'Void a recorded payment; it stays on the statement history' })
  voidPayment(@Param('paymentId') paymentId: string, @Body() dto: VoidOfficePaymentDto) {
    return this.accounts.voidPayment(paymentId, dto.reason);
  }

  @Patch(':id')
  @RequirePermission('buses.accounts')
  @ApiOperation({ summary: 'Edit an office; rate changes apply to new trips only' })
  update(@Param('id') id: string, @Body() dto: UpdateBusOfficeDto) {
    return this.accounts.updateOffice(id, dto);
  }

  @Get(':id/statement')
  @RequirePermission('buses.rates')
  @ApiOperation({ summary: "An office's monthly statement: rent minus expenses, payments and balance" })
  statement(@Param('id') id: string, @Query() query: StatementQuery) {
    return this.accounts.statement(id, query);
  }

  @Post(':id/payments')
  @RequirePermission('buses.accounts')
  @ApiOperation({ summary: "Record a payment against an office's month" })
  addPayment(@Req() req, @Param('id') id: string, @Body() dto: CreateOfficePaymentDto) {
    return this.accounts.addPayment(req.user.userId, id, dto);
  }
}
