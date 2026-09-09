# nest-webtransport-otel

영문 원문: [README.md](README.md)

`nest-webtransport`를 위한 선택적 OpenTelemetry 통합입니다. OpenTelemetry를 transport-neutral
core package에서 제외합니다.

```ts
import { Module } from '@nestjs/common';
import { WebTransportModule } from 'nest-webtransport';
import { WebTransportOtelModule } from 'nest-webtransport-otel';

const driver = createDriver(); // WebTransportModule에 전달한 것과 정확히 같은 driver를 재사용합니다.

@Module({
  imports: [
    WebTransportModule.forRoot({ driver, server, security }),
    WebTransportOtelModule.forRoot({ driver }),
  ],
})
export class ObservabilityModule {}
```

Module은 driver 기반 session, stream, datagram, byte instrument와 handler duration, error
metric, span을 위한 global WebTransport interceptor를 export합니다. Nest bootstrap 전에
애플리케이션에서 OpenTelemetry SDK와 exporter를 구성하세요. 이 package는 OpenTelemetry
API를 통해서만 내보냅니다.

Nest runtime이 설치되어 있으면 admission rejection, datagram drop(제한된 reason label),
retained byte, handler occupancy, suppressed log를 위한 `webtransport.runtime.*` instrument도
내보냅니다. 이는 driver/network counter와 다릅니다. Standalone `WebTransportMetrics`
collector는 `health.getRuntimeStats()`를 읽는 `runtimeStats` callback을 제공할 수 있습니다.

Span에서 payload 또는 credential이 유출되지 않도록 exception detail은 기본적으로 일반적인
error로 처리됩니다. 적절한 exporter redaction policy가 있을 때만
`recordExceptionDetails: true`를 활성화하세요. Query string과 URL fragment는 path attribute에서
항상 제외됩니다. SDK/exporter는 애플리케이션이 소유합니다.
