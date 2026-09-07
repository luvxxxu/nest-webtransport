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
