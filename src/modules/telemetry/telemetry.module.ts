import { Module } from '@nestjs/common';
import { HttpModule, HttpService } from '@nestjs/axios';
import { TelemetryClient } from './telemetry';

/**
 * Telemetry module — provides TelemetryClient for the rest of the
 * node app. The client is constructed but NOT started here:
 * node-runtime.ts calls `client.configure({...})` then `client.start()`
 * once peerId + hardware fingerprint + wallet are all known.
 *
 * Factory provider: bypasses NestJS reflection on TelemetryClient's
 * constructor so the plain-object `options` param (an interface type,
 * invisible to reflect-metadata) never causes an UnknownDependenciesException.
 */
@Module({
  imports: [HttpModule],
  providers: [
    {
      provide: TelemetryClient,
      useFactory: (http: HttpService) => new TelemetryClient(http),
      inject: [HttpService],
    },
  ],
  exports: [TelemetryClient],
})
export class TelemetryModule {}
