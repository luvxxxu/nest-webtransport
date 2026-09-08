# nest-webtransport-otel

Optional OpenTelemetry integration for `nest-webtransport`. It keeps OpenTelemetry out of the
transport-neutral core package.

```ts
import { Module } from '@nestjs/common';
import { WebTransportModule } from 'nest-webtransport';
import { WebTransportOtelModule } from 'nest-webtransport-otel';

const driver = createDriver(); // Reuse the exact driver passed to WebTransportModule.

@Module({
  imports: [
    WebTransportModule.forRoot({ driver, server, security }),
    WebTransportOtelModule.forRoot({ driver }),
  ],
})
export class ObservabilityModule {}
```

The module exports driver-backed session, stream, datagram, and byte instruments plus a global
WebTransport interceptor for handler duration, error metrics, and spans. Configure an OpenTelemetry
SDK and exporter in the application before Nest bootstrap; this package only emits through the
OpenTelemetry API.


With the Nest runtime installed, the module also emits `webtransport.runtime.*` instruments for
admission rejections, datagram drops (with bounded reason labels), retained bytes, handler occupancy
and suppressed logs. These are distinct from driver/network counters. Standalone `WebTransportMetrics`
collectors can supply a `runtimeStats` callback reading `health.getRuntimeStats()`.

Exception details default to a generic error to avoid leaking payloads or credentials in spans.
Enable `recordExceptionDetails: true` only with an appropriate exporter redaction policy. Query strings
and URL fragments are always omitted from path attributes. The application owns its SDK/exporter.
