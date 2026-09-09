# 아키텍처

영문 원문: [architecture.md](architecture.md)

`nest-webtransport`는 교체 가능한 드라이버 경계를 가진 전송 프레임워크입니다. Nest 런타임은
구체적인 QUIC 라이브러리를 직접 감싸지 않으며, core 계약은 NestJS를 알지 못합니다.

## 의존성 경계

```text
Nest application
        │
        ▼
nest-webtransport
  discovery · routing · execution · lifecycle
        │
        ├──────────────▶ webtransport-core ◀──────── custom driver contract
        │
        └──────────────▶ webtransport-driver-rwebtransport
                                      │
                                      ▼
                    rwebtransport · HTTP/3 · QUIC · UDP

nest-webtransport-testing ──▶ webtransport-core
```

의존성 규칙은 다음과 같이 기계적으로 적용됩니다.

1. `webtransport-core`는 NestJS와 `rwebtransport`를 모두 가져오지 않습니다.
2. `nest-webtransport`는 core를 가져오고, 기본 설치 경로로 사용할 수 있도록 네이티브
   드라이버를 다시 내보냅니다. 애플리케이션은 core 계약을 구현하는 모든 드라이버를
   주입할 수 있습니다.
3. `rwebtransport`를 가져오는 것은 `webtransport-driver-rwebtransport`뿐입니다.
4. 테스트 패키지는 core를 가져오며 NestJS나 네이티브 QUIC 없이 사용할 수 있습니다.

Core의 공개 계약은 Web Platform 값인 `Uint8Array`, `ReadableStream`, `WritableStream`,
`Headers`, `AbortSignal`, `DOMException`을 사용합니다. Node stream, `Buffer`, `EventEmitter`는
공개 전송 API의 일부가 아닙니다.

## 패키지별 역할

### Core

`webtransport-core`는 다음을 정의합니다.

- `WebTransportDriver`, capabilities, server options, stop options, stats
- 세션 상태, 세션 컨텍스트, close options 및 선택적 TLS keying-material export
- 양방향, 송신 전용, 수신 전용, 데이터그램 계약
- handler, stream, session, server, fatal failure을 위한 범위 지정 오류
- 서버 수명 주기 전환 및 liveness/readiness snapshot
- 제한된 큐, 동시성 제한, 고정 창 속도 제한, resource-limit type
- opt-in codec interface 및 `rawWebTransportCodec`

Core에는 네트워크 구현이 없습니다. 유틸리티는 프레임워크가 소유하는 큐를 명시적이고
제한된 형태로 만드는 데에도 사용됩니다.

### Nest 통합

`nest-webtransport`는 dynamic module, metadata decorator, bootstrap discovery, 컴파일된
handler registry, execution pipeline, runtime pump, resource policy, shutdown, 구조화된
logging, health reporting을 소유합니다. 내부 registry·dispatcher 클래스는 공개 export가
아닙니다.

### 네이티브 드라이버

`webtransport-driver-rwebtransport`는 `rwebtransport` 0.2.2 서버 세션을 core 계약으로
매핑합니다. 프레임워크 세션 ID, 상태·abort signal, `bigint` stream ID, 오류 매핑, counter,
connection-stat snapshot, keying-material export, graceful drain 호출을 제공합니다.

### 테스트

`nest-webtransport-testing`은 메모리 안에서 동일한 driver/session/stream 형태를 제공합니다.
연결된 endpoint는 제한된 Web Stream과 결정적인 close/abort 동작을 사용하므로 대부분의
프레임워크 테스트를 TLS, UDP 또는 네이티브 addon 없이 실행할 수 있습니다.

## 부트스트랩과 세션 admission

```text
Nest module initialization
        │
        ├─ discover providers with @WebTransportGateway
        ├─ scan method and parameter metadata once
        └─ compile GatewayRegistry
                │
application bootstrap
        │
        ├─ subscribe to driver sessions
        ├─ start driver
        └─ state = RUNNING
                │
driver surfaces a session
        │
        ├─ lifecycle and gateway-path check
        ├─ global/header/origin validation
        ├─ per-IP admission and rate limit
        ├─ create SessionContext
        ├─ authenticate()
        ├─ run @OnSession handlers
        └─ start pumps only for registered handler kinds
```

Gateway decorator는 메타데이터만 기록합니다. `DiscoveryService`가 인스턴스화된 클래스를
찾으려면 gateway가 Nest provider graph 안에 있어야 합니다.

Admission과 `@OnSession()`은 설정된 handshake timeout을 공유합니다. 세션 handler는 상태를
초기화하고 반환해야 합니다. admission이 성공한 뒤에 런타임이 pump를 시작하므로, 미래의
datagram이나 incoming stream을 기다려서는 안 됩니다.

## 라우팅은 프로토콜 중립적입니다

전송 계층은 gateway path, 원시 datagram, stream을 제공합니다. 애플리케이션 event name은
제공하지 않습니다.

따라서 기본 dispatch 경로에는 이름이 없습니다.

```ts
@OnDatagram()
handleDatagram(@Payload() bytes: Uint8Array) {}

@OnBidirectionalStream()
handleStream(@Stream() stream: WebTransportBidirectionalStream) {}
```

Resolver가 없으면 런타임은 payload를 원시 datagram 또는 stream으로 설정하고 이름 없는
handler만 찾습니다. 애플리케이션이 제공한 resolver가 route를 반환할 때 이름 있는
decorator가 활성화됩니다.

```text
raw value
   │
   ▼
routing.datagram / bidirectionalStream / unidirectionalStream
   │
   ├─ route   -> named registry key
   ├─ value   -> @Stream or underlying datagram value
   └─ payload -> @Payload
```

이름 없는 handler는 fallback이며 일치하는 이름 있는 handler와 함께 포함됩니다. 따라서
애플리케이션은 전체를 관찰하는 catch-all을 잃지 않고 프로토콜별 route를 추가할 수 있습니다.
프레임워크는 JSON, 선행 route byte, MessagePack, CBOR, Protobuf 또는 그 밖의 envelope을
지정하지 않습니다.

이름 있는 decorator도 해당 종류의 handler로 계산되므로 런타임이 incoming collection을
소유하고 pump를 시작합니다. 그러나 resolver가 없으면 어떤 route name도 일치할 수 없습니다.
일치하지 않는 datagram에는 호출 대상이 없으며, 일치하지 않는 양방향·단방향 stream은
프레임워크의 no-route code로 즉시 reset 또는 stop됩니다.

Route를 찾기 위해 byte를 소비하는 stream resolver는 남은 본문을 보존하는 replacement
stream/value를 반환해야 합니다. Stream을 읽는 작업은 파괴적이며 readable 쪽을 잠그므로,
route framing은 애플리케이션 프로토콜의 책임입니다.

## Readable 소유권과 backpressure

WHATWG `ReadableStream`에는 활성 reader가 하나만 있을 수 있습니다. Reader 소유권은 각
gateway path에서 incoming 종류별로 독립적으로 선택됩니다.

```text
at least one @OnDatagram handler
  -> runtime owns session.datagrams.readable
  -> @Payload()

at least one @OnBidirectionalStream handler
  -> runtime owns session.incomingBidirectionalStreams
  -> @Stream() / @Payload()

at least one @OnUnidirectionalStream handler
  -> runtime owns session.incomingUnidirectionalStreams
  -> @Stream() / @Payload()
```

이름 있는지 여부와 관계없이 해당 종류의 handler가 있으면 gateway 코드는 그 collection의
reader를 가져와서는 안 됩니다. 해당 path에 그 종류의 handler가 없으면 런타임은 pump를
시작하거나 reader를 가져오지 않으므로, 애플리케이션이 `@OnSession()`에서 완전한 수동
프로토콜을 구현할 수 있습니다. 런타임이 개별 stream을 handler에 전달한 뒤에는 handler가
그 stream 본문의 `readable`을 소유하고 평소처럼 pipe하거나 읽을 수 있습니다.

신뢰성 있는 stream의 압력은 Web Stream chain에 남습니다.

```text
application reads slowly
  -> ReadableStream demand falls
  -> driver pauses native reads
  -> QUIC flow control slows the peer
```

Datagram에는 신뢰성 있는 backpressure가 없습니다. 제한된 queue에 들어가며
`drop-oldest`, `drop-newest`, `reject`, `close-session` 중 하나를 사용합니다. 기본값은
256개 queue와 `drop-oldest` overflow입니다.

## 실행 pipeline과 상한

컴파일된 각 handler는 익숙한 Nest 순서를 따릅니다.

```text
ExecutionContext
  -> guards
  -> interceptors before
  -> global/class/method/parameter pipes
  -> handler
  -> interceptors after
  -> exception filters on failure
```

`WebTransportExecutionContext.getType()`는 `webtransport`를 반환합니다. Guard와 interceptor는
`switchToWebTransport(context)`를 호출해 Nest core를 수정하지 않고 session, stream, datagram,
resolved payload, `SessionContext`를 얻을 수 있습니다.

런타임은 packet마다 제한 없는 Promise 하나를 만들지 않습니다. 제한된 scheduler가 실행 중인
handler와 대기 중인 handler 수를 제한합니다. Stream pump는 다음 stream을 받기 전에
scheduler capacity를 기다리며, datagram은 스케줄링 전에 자체 제한 queue를 사용합니다.
Overflow 시 설정에 따라 작업을 폐기·거절하거나 session을 닫을 수 있습니다.

기본 제한은 다음과 같습니다.

| 경계 | 기본값 |
| --- | ---: |
| 전체 활성 세션(완료되지 않은 작업 포함) | 1,000 |
| 전체 동시 작업(authentication 포함) | 256 |
| 전체 추가 대기 작업 | 1,024 |
| 전체 활성 관리 incoming stream | 2,048 |
| 전체 보유 datagram byte | 16 MiB |
| IP별 활성 세션 | 100 |
| IP별 초당 session 시도 | 10 |
| 세션별 양방향 stream | 100 |
| 세션별 단방향 stream | 100 |
| 세션별 초당 datagram | 1,000 |
| 세션별 동시 handler | 64 |
| 세션별 대기 handler | 128 |
| Stream 수명 | 300초 |
| Datagram queue | 256 |

Datagram byte는 packet이 queue에 있거나 handler/resolver가 실행 중인 동안 계속 비용으로
계산됩니다. Aggregate 작업 reservation은 admission 및 local/global queue를 모두 포괄합니다.
협조적으로 종료되지 않은 연결 해제 작업은 완료될 때까지 reservation을 유지합니다. Global
작업 overflow는 `execution.overflow`를 사용하며, global byte ceiling은 도착한 datagram을
폐기합니다(공간이 맞으면 `drop-oldest` 교체는 허용됨).

이 값은 프레임워크 기본값일 뿐, 선택한 driver나 host가 같은 상한을 지원한다는 약속이 아닙니다.
더 낮은 native 또는 deployment limit이 우선합니다.

## 오류 격리

Core 오류에는 `code`, `cause`, `recoverable`, `scope`가 포함됩니다. 런타임은 가능한 가장
작은 경계에서 다음과 같이 scope을 처리합니다.

| Scope | 런타임 동작 |
| --- | --- |
| `HANDLER` | 실패한 호출 종료 |
| `STREAM` | 해당 stream reset 또는 stop |
| `SESSION` | 해당 session close |
| `SERVER` | 런타임 stop |
| `FATAL` | 런타임 stop |

알 수 없는 애플리케이션 오류는 기록하고 현재 handler 범위로 격리합니다. Background pump는
각자 rejection 처리를 연결하므로 stream 또는 session 오류가 처리되지 않은 process rejection이
되지 않습니다.

## 수명 주기, 종료, health

```text
STARTING -> RUNNING -> DRAINING -> STOPPING -> STOPPED
```

Graceful shutdown 중 Nest 런타임은 session 수락을 중지하고, 설정된 `drainTimeoutMs`까지
예약된 handler를 기다리고, 활성 session을 닫고, `forceCloseTimeoutMs` 안에 driver를
중지합니다. 네이티브 driver도 drain signal을 보내고 stop timeout까지 session을 기다린 뒤
강제 종료합니다.

`WebTransportHealthService`는 서로 다른 두 답을 제공합니다.

- `alive`: process/runtime 수명 주기가 살아 있습니다.
- `ready`: runtime이 `RUNNING`이고 새 session을 수락합니다.

`DRAINING`은 alive이지만 ready가 아니며, Kubernetes probe의 예상 의미와 일치합니다.

## 보안 경계

런타임은 origin, aggregate header size, 애플리케이션 authentication, 전체/IP별 session
limit, datagram size/rate, handler capacity, stream count/lifetime, idle time을 검사합니다.
이 검사는 영향을 받은 session 또는 stream을 닫아 fail closed 방식으로 동작합니다.

중요한 네이티브 timing 경계가 있습니다. `rwebtransport` 0.2.2에는 동적 pre-CONNECT
authentication callback이 없습니다. handshake 시점에 가능한 유일한 애플리케이션 admission
수단은 정적 `allowedOrigins` 목록입니다. 이식 가능한 Nest `security.authenticate`, header
검사, resource-limit 검사는 네이티브 driver가 established session을 노출하는 즉시
실행되며, 이 단계의 거절은 HTTP/3 CONNECT 거절이 아니라 즉시 session close입니다.
`RWebTransportDriver` 자체에 handshake 목록을 설정하고 별도의 Nest Origin 정책과 맞추세요.
[보안 모델](security.ko.md)을 참고하세요.

## 관측 가능성

구현된 기본 기능은 다음과 같습니다.

- 구조화된 runtime record(`event`, timestamp, session/stream identifier, 안전한 error code)
- aggregate driver session, stream, datagram, byte counter
- best-effort connection별 native stats
- liveness와 readiness용 health snapshot

런타임은 authorization header, cookie, raw token, payload를 기록하지 않습니다. 선택적
`nest-webtransport-otel`은 leaf package입니다. 공개 driver stats를 관찰하고 handler duration,
error, span을 위한 WebTransport 전용 Nest interceptor를 등록합니다. core와 driver 계약은
OpenTelemetry를 가져오지 않습니다.

## 런타임과 릴리스 경계

Bun 1.3.12가 dependency와 저장소 script를 관리합니다. 네이티브 driver의 프로덕션 실행은
`rwebtransport` 0.2.2의 binary/runtime matrix에 맞춰 Node.js 24.x 또는 26.x를 사용하며,
Bun native server가 아닙니다.

v1 릴리스 후보 gate에는 unit/virtual integration, certificate pinning을 적용한 실제 native
client/server QUIC, Chromium E2E, overload 및 stream flood 거절, killed-client native
idle-timeout 회귀, resource/memory 검사를 포함한 지속 부하, 깨끗한 npm tarball 설치가
포함됩니다. 고정한 driver에는 session rejection cleanup과 incoming queue 상한을 위한
재현 가능한 upstream JavaScript bundle patch가 포함되며, native QUIC/TLS code는 변경하지
않았습니다.

[릴리스 절차](releasing.ko.md)와 [릴리스 보고서](release-report.ko.md)에서 명령과 측정 결과를
확인하세요. 한 host에서 통과한 테스트만으로 전체 platform matrix를 확정할 수 없습니다.
Release CI는 Node 24·26을 사용하는 Linux x64와 macOS arm64에서 native·browser gate를
실행하며, 기존 unit/build CI는 Linux arm64와 Windows x64도 다룹니다.

`1.0.0` API 또는 특정 프로덕션 배포를 홍보하기 전에 다음도 검증해야 합니다.

- 정확한 target OS/architecture와 배포의 Docker/Kubernetes configuration
- 예상 workload에서 network loss, latency, jitter, reordering, MTU, NAT 동작
- target 규모에서 24–72시간 soak 및 file-descriptor/native memory 동작
- 애플리케이션별 authentication, outbound 작업 상한, SemVer/API 약속

## v1 동작 변경

`SessionContext.touch()`는 성공적으로 수동 소비하거나 outgoing I/O를 수행한 뒤 idle deadline을
갱신합니다. `security.idleTimeoutMs: 0`으로 framework idle timer를 명시적으로 끌 수 있습니다.
Decorator로 관리되는 stream은 활성 상태인 동안 idle 만료를 멈추지만 독립적인 lifetime limit은
유지합니다. 수동·outgoing stream의 동시성, drain, lifetime은 애플리케이션이 관리해야 합니다.

`WebTransportHealthService.getRuntimeStats()`는 native transport counter와 별도로 runtime
admission 및 drop reason을 보고합니다. Runtime log는 기본적으로 초당 최대 100개이며 suppression
counter가 있습니다. `observability.maxLogsPerSecond`는 이 상한과 완료되지 않은 비동기 callback
record의 최대 수를 함께 설정합니다. 거절된 callback Promise는 격리됩니다. 선택적
`observability.onError(error, record)` callback은 같은 log budget 아래에서 private diagnostic을
받습니다. Callback은 nonblocking으로 유지하고 내보내기 전에 error detail을 비식별화하세요.
Runtime과 함께 Nest module이 있으면 OTel이 이 runtime metric을 자동으로 검색합니다.

실행 중인 runtime의 driver가 RUNNING을 벗어나면, STOPPING에서 멈춘 경우를 포함해 health를
unhealthy로 처리합니다. 정상 runtime DRAINING은 live이지만 unready입니다. Driver는 선택적
`session.drain()` notification을 노출할 수 있으며, runtime은 intake를 멈추기 전에 이를
호출합니다. 취소된 incoming collection은 아직 처리할 active stream이 있는 session을 닫지
않고 새 stream을 거절합니다.
