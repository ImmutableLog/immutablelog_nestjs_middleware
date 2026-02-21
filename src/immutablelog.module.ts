import { DynamicModule, Module, Provider } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ImmutableLogInterceptor, ImmutableLogOptions } from './immutablelog.interceptor';

const IMTBL_OPTIONS = 'IMTBL_OPTIONS';

@Module({})
export class ImmutableLogModule {
  static forRoot(opts: ImmutableLogOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: IMTBL_OPTIONS,
      useValue: opts,
    };

    const interceptorProvider: Provider = {
      provide: APP_INTERCEPTOR,
      useFactory: (options: ImmutableLogOptions, reflector: Reflector) =>
        new ImmutableLogInterceptor(options, reflector),
      inject: [IMTBL_OPTIONS, Reflector],
    };

    return {
      module: ImmutableLogModule,
      providers: [optionsProvider, interceptorProvider],
    };
  }
}
