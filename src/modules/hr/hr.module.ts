import { Module } from '@nestjs/common';
import { CashModule } from '../cash/cash.module';
import { AdjustmentsService } from './adjustments.service';
import { AdvancesService } from './advances.service';
import { DocumentsService } from './documents.service';
import { EmployeeFilesService } from './employee-files.service';
import { HrCoreService } from './hr-core.service';
import { AdjustmentsController, AdvancesController, HrEmployeesController, HrSelfController, LeavesController, LeaveTypesController, PayrollController, SettlementsController } from './hr.controller';
import { LeavesService } from './leaves.service';
import { PayrollService } from './payroll.service';
import { SettlementsService } from './settlements.service';

@Module({
  imports: [CashModule],
  controllers: [HrSelfController, HrEmployeesController, LeaveTypesController, LeavesController, AdvancesController, AdjustmentsController, PayrollController, SettlementsController],
  providers: [HrCoreService, DocumentsService, LeavesService, AdvancesService, AdjustmentsService, PayrollService, SettlementsService, EmployeeFilesService],
  exports: [HrCoreService, LeavesService, AdjustmentsService],
})
export class HrModule {}
