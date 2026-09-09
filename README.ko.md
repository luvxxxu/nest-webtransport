# nest-webtransport

영문 원문: [README.md](README.md)

NestJS를 위한 드라이버 기반 WebTransport 프레임워크입니다. Nest의 검색·실행 계층을
HTTP/3·QUIC 구현과 분리하고, Web 표준 스트림을 노출하며, 프레임워크가 소유하는 작업
큐에 명시적인 상한을 둡니다.

`1.0.0-rc.1`은 v1 릴리스 후보입니다. core, Nest 런타임, 네이티브 드라이버, 테스트
유틸리티와 선택적 OpenTelemetry 통합을 제공합니다. 릴리스 검사는 실제 네이티브 QUIC와
Chromium 통신, admission/overload 동작, 피어의 비정상 종료, 지속 부하, 패키지의
독립 설치를 포함합니다. 프로덕션 강화 작업과 남은 인증 단계는 [v1 보고서](docs/v1-readiness.ko.md)에
기록되어 있습니다. 필수 검사와 범위는 [릴리스 검증](docs/releasing.ko.md)을 참고하세요.

## 패키지

| 패키지 | 역할 |
| --- | --- |
| `webtransport-core` | 런타임 중립 드라이버, 세션, 스트림, 데이터그램, 수명 주기, 제한, 오류 계약 |
| `nest-webtransport` | 동적 모듈, gateway 검색, 라우팅, Nest 실행 파이프라인, 제한, 종료, 상태 확인 및 네이티브 드라이버 |
| `webtransport-driver-rwebtransport` | `rwebtransport` 0.2.2 및 네이티브 HTTP/3·QUIC용 Node.js 어댑터 |
| `nest-webtransport-testing` | 결정적 가상 드라이버, 연결된 세션·스트림, 메모리 내 테스트 클라이언트 |
| `nest-webtransport-otel` | 선택적 OpenTelemetry 드라이버 지표, 핸들러 지표 및 tracing |

의존성 방향은 다음과 같이 고정되어 있습니다.

```text
Nest application
  -> nest-webtransport
    -> webtransport-core
    -> webtransport-driver-rwebtransport -> rwebtransport -> HTTP/3 -> QUIC -> UDP

Tests
  -> nest-webtransport-testing
    -> webtransport-core
```

Nest 패키지는 한 패키지만 설치해도 사용할 수 있도록 포함된 네이티브 드라이버를 다시
내보냅니다. 사용자 정의 드라이버도 같은 core 계약을 통해 주입할 수 있습니다. `rwebtransport`를
가져오는 것은 네이티브 드라이버뿐이며, core는 NestJS나 특정 드라이버를 가져오지 않습니다.
공개 전송 계약은 `Uint8Array`, `ReadableStream`, `WritableStream`, `Headers`, `AbortSignal`을
사용합니다.

## 구현된 런타임

- 주입된 드라이버를 지원하는 `WebTransportModule.forRoot()` 및 `forRootAsync()`
- 부트스트랩 시 gateway 검색 및 컴파일된 핸들러 레지스트리
- 세션, 데이터그램, 양방향 스트림, 단방향 스트림 핸들러
- WebTransport 핸들러용 Nest guard, pipe, interceptor, exception filter
- 제한된 핸들러 스케줄링, 제한된 데이터그램 큐, 속도 제한, 세션·스트림 제한 및
  유휴·스트림 타임아웃
- 세션 범위 취소와 핸들러·스트림·세션·서버 오류 격리
- drain 우선 종료와 `WebTransportHealthService`를 통한 liveness/readiness snapshot
- 헤더·토큰·payload를 기록하지 않는 구조화된 런타임 로그와 드라이버 카운터
- `rwebtransport` 세션, 스트림, 데이터그램, 오류, 통계 및 keying-material 어댑터
- 네이티브 QUIC 없이 통합 테스트를 수행하는 가상 드라이버와 클라이언트
- core에 OTel 의존성을 추가하지 않는 선택적 OpenTelemetry 계측과 핸들러 span
- 기본 및 프로덕션 예제. 프로덕션 예제에는 JWT, Redis, Prometheus 출력, Docker,
  Kubernetes manifest가 포함됩니다.

브로커 기반 노드 간 메시징은 포함하지 않습니다. 각 배포 환경에 맞게 네트워크 장애 동작과
작업량 제한을 검증하세요. 로컬 릴리스 검사는 인프라별 부하 테스트를 대신하지 않습니다.

## 설치

```sh
npm install nest-webtransport @nestjs/common @nestjs/core reflect-metadata rxjs
```

NestJS 12와 Node.js 24.x 또는 26.x를 사용하세요. 가상 테스트에는
`nest-webtransport-testing`을, telemetry에는 `@opentelemetry/api`와 함께
`nest-webtransport-otel`을 추가합니다. 모든 패키지는 ESM을 사용합니다.

## Gateway 예제

핸들러는 기본적으로 원시 형태이며 이름이 없습니다. 이는 zero-protocol 경로입니다.
WebTransport로 전송되는 byte에 이벤트 envelope이나 codec을 강제하지 않습니다.

```ts
import { Module } from '@nestjs/common';
import {
  OnBidirectionalStream,
  OnDatagram,
  OnSession,
  Payload,
  Session,
  Stream,
  WebTransportGateway,
  WebTransportModule,
  RWebTransportDriver,
  type WebTransportBidirectionalStream,
  type WebTransportSession,
} from 'nest-webtransport';

@WebTransportGateway('/realtime')
class RealtimeGateway {
  @OnSession()
  onSession(@Session() session: WebTransportSession): void {
    // 세션 로컬 상태를 초기화하고 반환합니다. admission과 세션 핸들러가
    // 완료되면 런타임이 등록된 핸들러 종류의 pump를 시작합니다.
    console.info('connected', session.id);
  }

  @OnDatagram()
  onDatagram(@Payload() datagram: Uint8Array): void {
    // 하나의 Uint8Array는 신뢰성 없는 데이터그램 하나입니다.
    console.info('datagram bytes', datagram.byteLength);
  }

  @OnBidirectionalStream()
  async onStream(@Stream() stream: WebTransportBidirectionalStream): Promise<void> {
    // 런타임이 스트림을 수락하고 gateway가 본문을 소비합니다.
    await stream.readable.pipeTo(stream.writable);
  }
}

@Module({
  imports: [
    WebTransportModule.forRoot({
      // driver 옵션은 정적이며 CONNECT 전에 수행하는 Origin 검사입니다.
      // 아래의 이식 가능한 Nest admission 정책과 맞춰야 합니다.
      driver: new RWebTransportDriver({
        allowedOrigins: ['https://app.example.com'],
      }),
      server: {
        host: '0.0.0.0',
        port: 4433,
        tls: {
          certificate: { kind: 'path', path: '/run/tls/tls.crt' },
          privateKey: { kind: 'path', path: '/run/tls/tls.key' },
        },
      },
      security: {
        requireOrigin: true,
        allowedOrigins: ['https://app.example.com'],
      },
    }),
  ],
  providers: [RealtimeGateway],
})
export class AppModule {}
```

Gateway 클래스는 Nest provider로 등록해야 합니다. `@WebTransportGateway()`는 메타데이터를
기록할 뿐, 클래스를 DI 컨테이너에 추가하지 않습니다.

### 이름 있는 핸들러에는 resolver가 필요합니다

WebTransport에는 애플리케이션 이벤트 이름이 없습니다. `@OnDatagram('position')`과 같은
선언은 설정된 resolver가 같은 route를 반환할 때만 선택됩니다.

```ts
WebTransportModule.forRoot({
  driver,
  server,
  routing: {
    datagram(datagram) {
      if (datagram[0] === 1) {
        return {
          route: 'position',
          value: datagram,
          payload: datagram.subarray(1),
        };
      }

      return { value: datagram, payload: datagram };
    },
  },
});

@OnDatagram('position')
updatePosition(@Payload() payload: Uint8Array): void {
  // 이 예제에서 payload에는 애플리케이션이 정의한 route byte가 없습니다.
}
```

프레임워크는 첫 번째 byte나 다른 envelope을 의도적으로 정의하지 않습니다. 이는 애플리케이션
프로토콜에 속합니다. 이름 없는 핸들러는 fallback이며, 일치하는 이름 있는 핸들러와 함께
실행됩니다.

## 스트림 소유권

gateway 경로에서는 해당 종류의 decorator 핸들러가 하나 이상 등록된 경우에만 Nest 런타임이
세션 수준의 incoming collection을 소유합니다.

- `@OnDatagram()` 핸들러가 있으면 `session.datagrams.readable`
- `@OnBidirectionalStream()` 핸들러가 있으면 `session.incomingBidirectionalStreams`
- `@OnUnidirectionalStream()` 핸들러가 있으면 `session.incomingUnidirectionalStreams`

이름 있는 핸들러인지와 관계없이 해당 종류의 핸들러가 있으면 gateway 코드에서 collection에
`getReader()`를 호출하지 마세요. 대신 `@Payload()` 또는 `@Stream()`으로 선택된 값을 받습니다.
해당 경로에 그 종류의 핸들러가 전혀 없으면 런타임은 collection을 건드리지 않으며,
`@OnSession()` workflow가 수동으로 소비할 수 있습니다. 수동 또는 outgoing I/O가 성공한
뒤에는 `context.touch?.()`를 호출해 idle deadline을 갱신하거나 `security.idleTimeoutMs: 0`으로
설정하고 idle 정리를 직접 관리하세요. stream handler에 전달된 stream 객체의
`stream.readable`은 애플리케이션 코드가 소유하며 Web Stream backpressure를 유지합니다.

## 런타임 요구 사항

- Bun 1.3.12는 저장소의 패키지 관리자이자 script runner입니다. 게시된 패키지가
  Bun 런타임 패키지라는 뜻은 아닙니다.
- 네이티브 `rwebtransport` 0.2.2 드라이버에는 Node.js 24.x 또는 26.x가 필요합니다.
- TypeScript는 strict NodeNext ESM 및 Web Platform type을 사용하도록 설정되어 있습니다.

`rwebtransport` 0.2.2에는 동적 pre-CONNECT 인증 hook이 없습니다. 따라서 CONNECT 전에
사용할 수 있는 유일한 애플리케이션 admission 검사는 정적 `allowedOrigins` driver 옵션입니다.
Nest header 검사, resource limit, `authenticate()`는 established session이 노출되는 즉시
실행되며, 실패하면 session을 닫습니다. 설정 경계는 [보안 모델](docs/security.ko.md)을
참고하세요.

```bash
bun install
bun run check
```

## 문서

- [아키텍처](docs/architecture.ko.md)
- [보안 모델](docs/security.ko.md)
- [QUIC 없이 테스트하기](docs/testing.ko.md)
- [릴리스 검사 및 게시](docs/releasing.ko.md)
- [프로덕션 예제](examples/production/README.ko.md)
- [브라우저 WebTransport 데모](examples/web-demo/README.ko.md)

보안 및 릴리스 경계는 API 계약의 일부입니다. 신뢰할 수 없는 트래픽에 서버를 노출하기 전에
반드시 읽으세요.

## 라이선스

MIT입니다. 네이티브 드라이버에는 `rwebtransport` 0.2.2용 Apache-2.0 호환성 bundle과
해당 라이선스·notice가 포함되어 있습니다. 의존성이 네이티브 binary를 제공하며 upstream의
제3자 notice를 유지합니다. 법적 기준은 [LICENSE](LICENSE) 원문을 따릅니다.
