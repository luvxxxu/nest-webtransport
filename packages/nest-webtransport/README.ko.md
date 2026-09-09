# nest-webtransport

영문 원문: [README.md](README.md)

WebTransport를 위한 NestJS 12 통합 package입니다. Gateway, session/datagram/stream
decorator, admission, 제한된 scheduling, Nest guard/pipe/interceptor/filter, graceful
shutdown을 제공합니다.

```sh
npm install nest-webtransport @nestjs/common @nestjs/core reflect-metadata rxjs
```

`nest-webtransport`에는 native `rwebtransport` driver가 포함됩니다. 이 package에서 Nest
runtime과 `RWebTransportDriver`를 함께 import하면 됩니다. Driver package는 transitively
설치됩니다.

ESM 및 Node.js 24.x 또는 26.x가 필요합니다. Decorator가 붙은 gateway class를 Nest provider로
등록하고 `WebTransportModule.forRoot({driver, server, security})` 또는 `forRootAsync(...)`를
구성하세요. Module과 native driver 양쪽에 명시적인 Origin allowlist를 설정하세요. Dynamic
authentication은 HTTP/3 CONNECT 수락 전이 아니라 established session이 노출된 직후 실행됩니다.

`@OnSession()`은 session을 초기화합니다. `@OnDatagram()`은 `@Payload()`를 통해
`Uint8Array`를 받고, `@OnBidirectionalStream()`과 `@OnUnidirectionalStream()`은
`@Stream()`을 통해 해당 stream을 받습니다. Connection에는 `@Session()`을, principal,
metadata, abort signal에는 `@WebTransportContext()`를 사용하세요. 이 signal을 cancellable
I/O에 전달하세요. 이름 있는 handler에는 routing resolver가 필요하며 raw handler에는 envelope
또는 codec이 필요하지 않습니다.

Decorator handler가 있는 종류에서는 framework가 incoming collection reader를 소유합니다.
Handler는 전달된 stream body를 소유합니다. Framework가 소유한 collection에서 다른 reader를
가져오지 마세요.

전체 예제와 API 안내:

- [Gateway 설정](https://github.com/luvxxxu/nest-webtransport#gateway-example)
- [아키텍처와 소유권](https://github.com/luvxxxu/nest-webtransport/blob/main/docs/architecture.md)
- [보안 모델](https://github.com/luvxxxu/nest-webtransport/blob/main/docs/security.md)
- [가상 테스트](https://github.com/luvxxxu/nest-webtransport/blob/main/docs/testing.md)

MIT license입니다.

v1에서는 `limits.server` 아래에 server-wide work, incoming-stream, queued-datagram-byte
limit이 추가되었습니다. 기본 session ceiling은 1,000이며, 늘리기 전에 workload qualification이
필요합니다. Application-level rejection/drop과 work occupancy는
`WebTransportHealthService.getRuntimeStats()`에서, transport counter는 `getDriverStats()`에서
확인하세요. Runtime log의 기본값은 초당 100 record이며, `observability.maxLogsPerSecond`와
선택적인 private `onError` callback을 구성할 수 있습니다. 수동 또는 outgoing I/O의 경우
성공적으로 진행한 뒤 `context.touch?.()`로 idle activity를 갱신하거나
`security.idleTimeoutMs: 0`으로 설정하고 application이 idle cleanup을 관리하세요.
