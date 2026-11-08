import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { SaveBranchDto, UpdateBranchDto } from '../cash/cash.dto';
import { AssignEmployeeDto, BranchPerformanceQuery, CreateBranchEmployeeDto, SetBranchManagerDto, UpdateAccessDto } from './branches.dto';
import { BranchesService } from './branches.service';

@ApiTags('Branches')
@Controller('branches')
@ApiBearerAuth()
export class BranchesController {
  constructor(private branches: BranchesService) {}

  @Get()
  @RequirePermission('branches.view', 'branches.all', 'branches.manage')
  @ApiOperation({ summary: "Every branch with today's figures, or only the caller's own" })
  list(@Req() req) {
    return this.branches.list(req.user);
  }

  @Post()
  @RequirePermission('branches.manage')
  @ApiOperation({ summary: 'Add a branch' })
  create(@Body() dto: SaveBranchDto) {
    return this.branches.create(dto);
  }

  @Get(':id/performance')
  @RequirePermission('branches.view', 'branches.all', 'branches.manage')
  @ApiOperation({ summary: 'What a branch sold lately, by day, employee and route' })
  performance(@Req() req, @Param('id') id: string, @Query() query: BranchPerformanceQuery) {
    return this.branches.performance(req.user, id, query.days ?? 30);
  }

  @Get(':id')
  @RequirePermission('branches.view', 'branches.all', 'branches.manage')
  @ApiOperation({ summary: "One branch's profile, performance and employees" })
  detail(@Req() req, @Param('id') id: string) {
    return this.branches.detail(req.user, id);
  }

  @Patch(':id')
  @RequirePermission('branches.manage')
  @ApiOperation({ summary: "Edit a branch's details or deactivate it" })
  update(@Param('id') id: string, @Body() dto: UpdateBranchDto) {
    return this.branches.update(id, dto);
  }

  @Put(':id/manager')
  @RequirePermission('branches.manage')
  @ApiOperation({ summary: 'Appoint the branch manager, moving them to this branch' })
  setManager(@Req() req, @Param('id') id: string, @Body() dto: SetBranchManagerDto) {
    return this.branches.setManager(req.user, id, dto.userId);
  }

  @Get(':id/candidates')
  @RequirePermission('branches.staff', 'branches.manage', 'employees.manage')
  @ApiOperation({ summary: 'Employees who can be added to this branch' })
  candidates(@Req() req, @Param('id') id: string, @Query('search') search?: string) {
    return this.branches.candidates(req.user, id, search);
  }

  @Post(':id/employees')
  @RequirePermission('branches.staff', 'branches.manage', 'employees.manage')
  @ApiOperation({ summary: 'Register a new employee in this branch' })
  createEmployee(@Req() req, @Param('id') id: string, @Body() dto: CreateBranchEmployeeDto) {
    return this.branches.createEmployee(req.user, id, dto);
  }

  @Post(':id/employees/assign')
  @RequirePermission('branches.staff', 'branches.manage', 'employees.manage')
  @ApiOperation({ summary: 'Add an existing employee to this branch' })
  assign(@Req() req, @Param('id') id: string, @Body() dto: AssignEmployeeDto) {
    return this.branches.assign(req.user, id, dto.userId);
  }

  @Delete(':id/employees/:userId')
  @RequirePermission('branches.staff', 'branches.manage', 'employees.manage')
  @ApiOperation({ summary: 'Take an employee out of this branch; the account stays' })
  removeEmployee(@Req() req, @Param('id') id: string, @Param('userId') userId: string) {
    return this.branches.removeEmployee(req.user, id, userId);
  }

  @Put(':id/employees/:userId/access')
  @RequirePermission('branches.staff', 'branches.manage', 'employees.manage')
  @ApiOperation({ summary: "Change an employee's rank and personal permission adjustments" })
  updateAccess(@Req() req, @Param('id') id: string, @Param('userId') userId: string, @Body() dto: UpdateAccessDto) {
    return this.branches.updateAccess(req.user, id, userId, dto);
  }
}
