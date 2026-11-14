import { Module } from '@nestjs/common';
import { ZatcaController } from './zatca.controller';
import { ZatcaService } from './zatca.service';
import { ZatcaWorkerService } from './zatca-worker.service';

@Module({
  controllers: [ZatcaController],
  providers: [ZatcaService, ZatcaWorkerService],
  exports: [ZatcaService],
})
export class ZatcaModule {}
