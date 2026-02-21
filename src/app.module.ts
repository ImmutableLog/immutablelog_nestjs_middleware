import { Module } from '@nestjs/common';
import { ImmutableLogModule } from './immutablelog.module';

@Module({
  imports: [
    ImmutableLogModule.forRoot({
      apiKey: process.env.IMTBL_API_KEY!,
      apiUrl: process.env.IMTBL_URL ?? 'https://api.immutablelog.com',
      serviceName: process.env.IMTBL_SERVICE_NAME ?? 'nestjs-service',
      env: process.env.IMTBL_ENV ?? 'production',
      skipPaths: ['/health', '/healthz', '/metrics'],
    }),
  ],
})
export class AppModule {}
