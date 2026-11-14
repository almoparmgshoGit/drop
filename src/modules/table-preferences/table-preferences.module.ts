import { Module } from '@nestjs/common';
import { TablePreferencesController } from './table-preferences.controller';
import { TablePreferencesService } from './table-preferences.service';

@Module({
  controllers: [TablePreferencesController],
  providers: [TablePreferencesService],
})
export class TablePreferencesModule {}
