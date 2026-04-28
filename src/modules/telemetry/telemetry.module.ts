import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TelemetryClient } from './telemetry';

/**
 * Telemetry module — provides TelemetryClient for the rest of the
 * node app. The client is constructed but NOT started here:
 * node-runtime.ts calls `client.configure({...})` then `client.start()`
 * once peerId + hardware fingerprint + wallet are all known.
 */
@Module({
  imports: [HttpModule],
  providers: [TelemetryClient],
  exports: [TelemetryClient],
})
export class TelemetryModule {}
