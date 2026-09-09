# 보안 모델

영문 원문: [security.md](security.md)

WebTransport는 HTTP/3 CONNECT 요청과 장기 QUIC session을 결합합니다. 따라서 admission
정책에는 두 가지 timing 경계가 있습니다. 하나는 native server가 CONNECT 처리 중 수행할
수 있는 검사이고, 다른 하나는 driver가 session을 노출한 직후 Nest runtime이 수행하는 검사입니다.

## Admission timing

| 검사 | `rwebtransport` 0.2.2에서 가능한 가장 이른 경계 |
| --- | --- |
| TLS certificate 및 private key | QUIC/TLS handshake |
| 정적 origin allowlist | native `allowedOrigins` 지원을 통한 CONNECT 수락 전 |
| 동적 token, cookie, database authentication | established session이 노출된 직후 |
| Aggregate header size 검사 | session 노출 직후 |
| 전체 및 IP별 애플리케이션 limit | session 노출 직후 |
| Datagram, stream, handler, idle limit | 수락된 session 중 |

`rwebtransport` 0.2.2는 동적 pre-CONNECT authorization callback을 노출하지 않습니다.
Nest authenticator 또는 resource check가 실패하면 새로 노출된 session을 닫으며, 그 결정을
HTTP/3 CONNECT 거절로 바꿀 수 없습니다. CONNECT 성공 전에 동적 authorization이 필요한
배포에는 향후 driver capability 또는 이 process 앞의 QUIC-aware admission 계층이 필요합니다.

이 driver 버전에서 CONNECT 전에 이용할 수 있는 유일한 애플리케이션 admission 검사는 native의
정적 `allowedOrigins` 기능입니다. `RWebTransportDriver` constructor option으로 노출됩니다.
Nest `security.allowedOrigins`는 session 노출 후 별도로 검사하며, module이 이미 생성된
driver에 이 portable option을 복사하지는 않습니다.

## 안전한 module configuration

```ts
import { RWebTransportDriver, WebTransportModule } from 'nest-webtransport';

const webTransport = WebTransportModule.forRoot({
  // rwebtransport는 CONNECT를 수락하기 전에 이 정적 목록을 적용합니다.
  driver: new RWebTransportDriver({
    allowedOrigins: ['https://app.example.com'],
  }),
  server: {
    host: '0.0.0.0',
    port: 4433,
    tls: {
      certificate: { kind: 'path', path: '/run/secrets/webtransport.crt' },
      privateKey: { kind: 'path', path: '/run/secrets/webtransport.key' },
    },
  },
  security: {
    allowedOrigins: ['https://app.example.com'],
    requireOrigin: true,
    maxHeaderSize: 16 * 1024,
    maxDatagramSize: 1_200,
    handshakeTimeoutMs: 5_000,
    idleTimeoutMs: 60_000,
    authenticate(session, context) {
      const authorization = session.headers.get('authorization');
      if (authorization !== 'Bearer expected-test-value') {
        return false;
      }

      return { subject: 'user-123', scopes: ['realtime'] };
    },
  },
  limits: {
    server: { maxSessions: 1_000, maxConcurrentHandlers: 128, maxPendingHandlers: 512,
      maxQueuedDatagramBytes: 8 * 1024 * 1024, maxStreams: 1_024 },
    ip: { maxSessions: 50, sessionsPerSecond: 5 },
    session: {
      maxBidirectionalStreams: 64,
      maxUnidirectionalStreams: 64,
      maxDatagramsPerSecond: 500,
      maxConcurrentHandlers: 32,
      maxPendingHandlers: 64,
    },
    stream: { maxLifetimeMs: 120_000 },
  },
  execution: {
    maxConcurrentHandlers: 32,
    maxPendingHandlers: 64,
    overflow: 'close-session',
  },
  datagrams: {
    queue: { size: 128, overflow: 'drop-oldest' },
  },
  shutdown: {
    graceful: true,
    drainTimeoutMs: 10_000,
    forceCloseTimeoutMs: 15_000,
  },
});
```

`authenticate()`가 반환한 값은 `SessionContext.principal`이 됩니다. `false`를 반환하거나
throw하거나 admission timeout을 넘기면 session이 거절됩니다. `undefined`를 반환하면
principal을 설정하지 않고 session을 허용합니다.

위의 간결한 예제처럼 프로덕션 bearer token을 비교하지 마세요. 애플리케이션에 맞게 서명,
issuer, audience, time claim, revocation policy를 검증하는 verifier를 사용하세요. credential을
route name, close reason, log field에 절대 넣지 마세요.

## Origin 동작

`requireOrigin`의 기본값은 `true`이며, 활성화된 동안 module은 비어 있지 않은
`security.allowedOrigins` 목록을 요구합니다. 정상적으로 Origin을 생략하는 client를 지원해야
한다면 `requireOrigin: false`를 의도적으로 설정하세요. 그래도 non-empty allowlist가 있으면
일치하지 않는 Origin이 포함된 요청은 거절됩니다.

Native pre-CONNECT 목록은 `new RWebTransportDriver({ allowedOrigins })`로 별도 설정합니다.
이 목록을 Nest 정책과 맞추세요. Driver 설정은 native server 수명 동안 정적이며, Nest 설정은
portable post-surface 검사입니다.

Origin은 serialize된 URL-origin 정규화 후 비교합니다. 애플리케이션이 소유한 scheme, host,
port만 포함하는 명시적 origin을 설정하세요. 임의의 Origin 값을 response header에 반영하지
마세요.

Browser가 아닌 client는 Origin을 생략할 수 있습니다. 별도 listener 또는 강한 session
authentication과 함께 `requireOrigin: false`를 사용하는 등 명시적인 정책 결정이 있을 때만
허용하세요.

## TLS credential

Core 계약은 path, PEM, byte credential을 표현할 수 있지만 현재
`webtransport-driver-rwebtransport` adapter는 filesystem path만 허용합니다. 다음은 거절됩니다.

- TLS configuration 누락
- inline PEM 또는 byte credential
- 빈 certificate/key path
- passphrase가 있는 암호화 private key

Certificate material은 read-only로 mount하고 service account만 읽을 수 있도록 권한을 제한하세요.
Live certificate reload가 구현될 때까지 관리된 restart로 교체하세요. Native driver에는 Node.js
24.x 또는 26.x가 필요합니다.

## Limit 및 overload 동작

프레임워크가 소유하는 모든 queue에는 상한이 있습니다. 각 overflow 정책의 보안 효과는
서로 다릅니다.

- `drop-oldest`: 최신 datagram 상태를 우선하며 position/telemetry update에 적합합니다.
- `drop-newest`: 이미 queue에 들어간 작업을 보호합니다.
- `reject`: 현재 작업 항목을 거절합니다.
- `close-session`: capacity를 넘어 계속 전송하는 peer를 제거합니다.

Handler scheduling은 `drop`, `reject`, `close-session`을 지원합니다. Reliable stream은
session collection에서 다음 stream을 수락하기 전에 scheduler capacity를 기다리며, 본문
backpressure는 underlying Web Stream에 남습니다. Datagram rate/size 실패는 runtime drop으로
집계되고 log는 속도 제한됩니다. Global byte budget은 queue에 있거나 실행·대기 중인 handler에
있는 datagram을 포함합니다. 전체 stream/work capacity를 넘는 reliable stream은 reset됩니다.

프레임워크 상한은 operating system, QUIC library, container, load balancer limit을 대신하지
않습니다. File descriptor, UDP buffer, memory, connection limit을 함께 산정한 뒤 부하에서
검증하세요.

## Guard와 handler authorization

Session authentication은 한 번 identity를 확립합니다. Handler별 authorization은 일반 Nest
guard와 WebTransport context를 사용할 수 있습니다.

```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { switchToWebTransport } from 'nest-webtransport';

@Injectable()
export class RealtimeScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const transport = switchToWebTransport(context);
    const principal = transport.getSessionContext().principal as
      | { scopes?: readonly string[] }
      | undefined;

    return principal?.scopes?.includes('realtime') === true;
  }
}
```

Pipe는 선택된 `@Payload()`를 검증하고, interceptor는 handler 실행을 감싸며, exception filter는
실패를 처리할 수 있습니다. 범위가 지정된 core 오류에 따라 런타임은 호출만 종료하거나,
stream을 reset하거나, session을 닫거나, server를 중지합니다.

## Logging과 secret 처리

Runtime의 구조화된 record에는 event name, timestamp, session/stream identifier, 안전한 error
code, error class name이 들어 있습니다. Authorization header, cookie, raw token, payload byte는
추가하지 않습니다. 사용자 정의 logger도 이 경계를 유지해야 하며 session 또는 context object를
통째로 serialize하지 마세요.

Session close reason은 네트워크를 통과합니다. 짧고 민감하지 않게 유지하세요. 세부 정보는
내부 error code와 연계된 server log로 기록하세요.

## 배포 점검 목록

- QUIC/TLS를 WebTransport over HTTP/3를 명시적으로 지원하는 component에서만 종료합니다.
- UDP를 의도적으로 노출하고 balance합니다. 일반 TCP/HTTP reverse proxy만으로는 충분하지 않습니다.
- 정확한 Origin allowlist를 설정하고 어디에서 적용되는지 확인합니다.
- 모든 session을 인증하고 `@OnSession()`을 admission timeout 안에서 끝냅니다.
- 실제 host에 맞춰 전체, IP별, stream, datagram, handler limit을 조정합니다.
- Drain 중 readiness는 false로 유지하고 liveness는 true로 유지합니다.
- 실제 native 환경에서 certificate error, Origin 누락, 잘못된 token, flood, abrupt disconnect,
  shutdown을 시험합니다.
- Browser, chaos, load, leak, soak gate가 통과하기 전에는 프로덕션 준비 완료라고 주장하지 않습니다.

## 취소와 보유 작업

Timeout 또는 disconnect는 `SessionContext.signal`을 abort합니다. Authenticator와 handler는
이 signal을 cancellable I/O에 전달해야 합니다. JavaScript는 임의의 Promise를 강제로 취소할
수 없으므로, 완료되지 않은 admission·handler 작업은 실제로 끝날 때까지 전체/IP별 capacity를
점유합니다. 이는 reconnect loop가 background operation을 누적시키는 대신 추가 작업을 의도적으로
거절하게 합니다. 절대 완료되지 않는 authenticator는 할당된 capacity를 소진할 수 있으므로
admission timeout과 함께 downstream I/O deadline도 사용하세요.

Native driver는 established session(기본 1,000)과 pending session callback(기본 1,024)을
별도로 제한하며, peer가 이미 떠난 callback도 포함합니다. 이 상한을 Nest limit과 맞추세요.
`driver.stop({timeoutMs})`는 전체 stop operation을 제한합니다. Native shutdown timeout이
발생하면 거절하고 상태를 `STOPPING`으로 남기므로, native close가 완료된 뒤 재시도할 수 있습니다.
실행 중인 runtime이 driver가 RUNNING이 아님을 발견하면, STOPPING에서 멈춘 경우를 포함해
runtime health는 liveness 실패를 보고합니다.

Timer는 Node의 2,147,483,647 ms 범위 안에 있어야 합니다. 더 큰 값은 1 ms timeout으로 바뀌지
않고 거절됩니다. OpenTelemetry path attribute는 URL credential 노출이나 ticket별 metric
series 생성을 막기 위해 query string과 fragment를 제외합니다.

고정된 native dependency의 server Promise cleanup에는 알려진 rejection 전파 결함이 있습니다.
제공되는 compatibility bundle은 fulfillment와 rejection을 모두 로컬에서 처리합니다. Killed-client
회귀 테스트는 실제 native idle timeout을 기다리며, 전역 unhandled-rejection handler는 설치하지
않습니다. 재현 가능한 patch와 license 세부 정보는 driver의 `vendor/README.md`를 참고하세요.

Upstream을 향한 incoming queue는 session 1,024개와 direction/session별 stream 256개로
독립적으로 제한됩니다. Queue를 넘긴 peer는 code 257로 close되며, stream body는 Web Stream
backpressure를 유지합니다. 이 상한은 Nest scheduler가 소비하기 전의 대기 작업을 보호합니다.
Framework stream limit은 decorator로 관리되는 incoming stream에 적용됩니다. 애플리케이션이
생성한 outgoing stream과 수동 소비 collection도 애플리케이션 수준에서 동시성과 lifetime을
관리해야 합니다. Module은 임의의 background workflow가 끝나는 시점을 추론할 수 없습니다.

## v1 수명과 진단

프로덕션 예제는 JWT 만료를 principal에 보존하고 해당 시점에 session을 닫습니다. 그래도
애플리케이션은 자체 revocation/distributed logout 정책을 구현해야 합니다. 예제의 Redis
operation은 제한된 queue, startup/command/shutdown deadline을 사용하며 dependency 실패 시
readiness를 실패로 처리합니다. Reconnect 시도가 소진되거나 command가 멈추면 liveness가
실패하여 orchestrator가 재시작할 수 있습니다.

수동 incoming collection과 애플리케이션이 생성한 outgoing stream은 framework pump를 통과하지
않습니다. 성공한 I/O 뒤 `SessionContext.touch()`를 호출하거나 `idleTimeoutMs: 0`으로 framework
idle timer를 끄고 애플리케이션에서 idle cleanup을 구현하세요. 해결되지 않은 user Promise는
disconnect 뒤에도 server work reservation을 유지하므로 모든 downstream I/O에 cancellation과
deadline을 사용하세요.

Driver counter와 함께 runtime `getRuntimeStats()`를 사용하세요. Authentication rejection,
datagram size/rate/queue 및 aggregate-budget drop은 native network drop metric이 아니라 runtime
metric에 속합니다. Runtime reason label은 고정된 vocabulary에서 나오며 client path, IP, token을
포함하지 않습니다. Logger와 `observability.onError`는 설정 가능한 초당 상한(기본 100)을
공유하며 억제된 record를 집계합니다. 비동기 callback rejection은 격리되고 pending record 수도
같은 상한을 사용합니다. 선택적 diagnostic callback은 raw error를 받으므로 export 전에
비식별화하세요. `recordExceptionDetails: true`를 명시적으로 켠 경우가 아니면 OTel은 일반적인
exception detail만 내보냅니다.

참고: [Node timer 범위](https://nodejs.org/api/timers.html),
[WebTransport 사양](https://www.w3.org/TR/webtransport/),
[Redis 프로덕션 지침](https://redis.io/docs/latest/develop/clients/nodejs/produsage/).
