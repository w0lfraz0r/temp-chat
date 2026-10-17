import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { ClientAddressService } from './client-address.service';
import { ApplicationState } from './application-state.service';

@Module({
  imports: [ConfigModule],
  providers: [ClientAddressService, ApplicationState],
  exports: [ClientAddressService, ApplicationState],
})
export class CommonModule {}
