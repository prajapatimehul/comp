import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FrameworksModule } from '../frameworks/frameworks.module';
import { ReadinessController } from './readiness.controller';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [AuthModule, FrameworksModule],
  controllers: [ReadinessController],
  providers: [ReadinessService],
})
export class ReadinessModule {}
