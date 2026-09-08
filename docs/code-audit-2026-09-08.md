# 코드 및 프로덕션 준비도 감사

현재 작업 트리 기준. 분석 대상은 core, Nest 실행 계층, rwebtransport 어댑터와 vendored JavaScript, testing, OTel, 예제 및 배포/검증 설정이다. 소스 수정 없이 기존 검사와 별도 재현을 수행했다. 기존 변경 `examples/basic/src/main.ts`는 보존했다.

판정: 기본 전송 기능과 기존 릴리스 검사는 통과하지만, **프로덕션 예제 기동과 Docker 빌드, 요청 범위 전역 enhancer, 정상 종료 처리에 먼저 수정해야 할 결함이 있다.** 아래 목록은 이번 검토에서 확인한 문제이며, 모든 결함의 부재를 증명하지 않는다.

P1은 해당 기능 사용 또는 배포를 막는 문제, P2는 특정 조건에서 데이터 처리·복구·운영 안정성을 해치는 문제로 분류했다. 정적 근거만 있는 위험과 직접 재현한 결과를 구분한다.

## P1 — 먼저 수정할 문제

### 1. 요청 범위 전역 Guard/Pipe/Interceptor/Filter의 DI 토큰이 잘못됨

- 위치: `packages/nest-webtransport/src/execution/execution-pipeline.ts:252–273`
- `resolveRequestEnhancers()`가 Nest의 실제 wrapper 대신 `wrapper.metatype`을 `moduleRef.resolve()`에 넘긴다.
- `APP_GUARD`의 `useClass` 등록은 별도 토큰 `APP_GUARD (UUID: ...)`으로 저장되므로 해당 클래스 자체는 조회되지 않는다. `useFactory`도 factory 함수를 provider 토큰으로 조회하는 문제가 생긴다.
- **재현:** `@Injectable({ scope: Scope.REQUEST })` Guard를 `{ provide: APP_GUARD, useClass: Guard }`로 등록했다. 항상 `true`를 반환하는 Guard인데도 `@OnSession()` 호출 0회, 세션 `CLOSED`를 확인했다. factory 방식도 동일했다. 원인은 `Nest could not find Guard element`이다.
- Guard 외 다른 전역 request enhancer도 동일 함수를 사용한다. 세션 핸들러가 없다면 이벤트 처리 시 실패한다.
- 개선: 등록된 wrapper의 token/host module/context를 이용해 실제 인스턴스를 로드한다. useClass/useFactory/useExisting, REQUEST 주입을 포함한 통합 검사가 필요하다.

### 2. 프로덕션 예제가 의존성을 주입받지 못해 기동 실패

- 위치: `examples/production/src/realtime.gateway.ts:17–22`, `examples/production/src/operations-server.service.ts:8–22`
- 생성자 DI에 사용하는 `RedisPresenceService`, `WebTransportHealthService`를 `import type`으로 가져오면서 명시적인 `@Inject()`를 사용하지 않는다.
- TypeScript 빌드는 성공하지만 생성된 `design:paramtypes`는 Gateway에서 `[Function]`, OperationsServer에서 `[Object, Function, Function]`이다.
- **재현:** 빌드한 Gateway와 Redis mock provider로 실제 Nest testing module을 compile하면 `Nest can't resolve dependencies of the RealtimeGateway ... Function at index [0]` 오류가 발생한다.
- 개선: runtime class import와 명시적 주입 토큰을 사용한다. 타입 검사만으로는 발견되지 않으므로 실제 예제 bootstrap 검사를 추가한다.

### 3. Docker build 단계에 필수 scripts 디렉터리가 없음

- 위치: `examples/production/Dockerfile:3–8`, 루트 `package.json`의 `build`
- build stage는 manifest, tsconfig, packages, production 예제만 복사한다. 그런데 `bun run build`는 `node scripts/vendor-rwebtransport.mjs`부터 실행한다.
- **정적 확인:** 이미지에 `/app/scripts/vendor-rwebtransport.mjs`를 넣는 COPY나 생성 단계가 없다. 의존성 설치가 성공해도 이 build 단계는 진행할 수 없다.
- 개선: build에 필요한 scripts와 일관된 workspace 입력을 포함한다. build stage에도 지원 Node 버전을 명시하고 clean-context Docker build를 검증한다.
- Docker daemon을 이용한 실제 이미지 빌드는 이번에 수행하지 않았다.

### 4. drain 중 새 스트림이 도착하면 기존 작업까지 즉시 끊음

- 위치: `packages/nest-webtransport/src/server/webtransport-runtime.ts:285–286,1234–1251`, `packages/driver-rwebtransport/vendor/rwebtransport.mjs:1282–1295`, 생성 원본 `scripts/vendor-rwebtransport.mjs`
- runtime은 drain 시작에 incoming reader를 cancel한다. vendored `onBidi/onUni`는 취소된 collection의 `desiredSize`를 용량 초과로 판단하여 세션 전체를 close한다.
- 드라이버의 `session.drain()` 통지는 runtime이 자기 drain을 끝내고 `driver.stop()`에 도달한 뒤 실행되므로 이 구간을 보호하지 못한다.
- **실제 QUIC 재현:** 처리 중인 uni 핸들러를 150ms 지연시킨 뒤 종료를 시작하고, `DRAINING` 상태에서 새 uni 스트림을 보냈다. 기존 핸들러가 끝나기 전에 `{ closeCode: 257, reason: 'incoming stream capacity exceeded' }`로 연결이 닫혔다.
- 개선: 취소/종료 상태와 실제 queue overflow를 구별한다. drain 중 새 스트림만 거절하고 기존 스트림은 마치게 하며, 가능하면 drain 통지를 intake 중단 전에 보낸다.

## P2 — 런타임 및 운영 문제

### 5. 수동으로 소비하는 세션은 계속 통신해도 idle timeout으로 닫힘

- 위치: `packages/nest-webtransport/src/server/webtransport-runtime.ts:1161–1174`, reader ownership 관련 README
- `touch()`는 framework pump와 decorator-managed stream 추적에서만 갱신된다. `@OnSession()`에서 직접 incoming collection을 읽는 공식 지원 경로에는 활동 추적이나 공개 touch API가 없다. 송신 전용 작업도 같은 제약이 있다.
- **재현:** datagram decorator 없이 `@OnSession()`에서 수동 datagram reader를 시작했다. 약 10ms마다 데이터를 보내 6개를 실제로 읽었지만 `idleTimeoutMs: 80` 부근에 code 259, `Session idle timeout`으로 닫혔다.
- 개선: 어댑터의 실제 활동을 runtime에 전달하거나 명시적인 activity 갱신 API/idle 정책을 제공한다. 외부 작업의 생명주기를 애플리케이션이 관리한다는 문서만으로 정상 트래픽의 강제 종료를 해결할 수 없다.

### 6. resolver가 빈 route를 반환하면 fallback 핸들러가 두 번 실행됨

- 위치: `packages/nest-webtransport/src/routing/gateway-registry.ts:45–62,101–106`
- registry key가 `undefined`와 `''`를 동일하게 취급하지만, find는 빈 문자열을 exact route로 조회한 뒤 같은 fallback 배열을 다시 합친다.
- **재현:** fallback 한 개를 등록하고 `find('/a', 'datagram', '')` 호출 → 결과 길이 2.
- decorator는 빈 route를 금지하지만 사용자 resolver의 결과에는 같은 검증이 없어 도달 가능한 경로다. 저장·전송 같은 부수 효과가 중복 실행될 수 있다.
- 개선: resolver 반환값의 빈 route를 거부/정규화하고 exact/fallback 중복 합산을 방지한다.

### 7. 인증 거절과 runtime 데이터그램 폐기가 운영 지표에서 빠짐

- 위치: runtime의 `validateSession()/authenticateAndRunSessionHandlers()/pumpDatagrams()`, `packages/driver-rwebtransport/src/driver.ts`의 counters, `packages/otel/src/metrics.ts`, `examples/production/src/operations-server.service.ts`
- Nest가 인증·Origin·자원 제한 등으로 세션을 닫아도 드라이버의 `sessionsRejected`가 증가하지 않는다. rate/size/queue 제한으로 폐기한 데이터그램 역시 드라이버 drop 지표에 전달되지 않는다.
- **실제 QUIC 재현:** 잘못된 인증으로 code 256 종료 후 rejected counter는 0. 초당 1개 제한에 3개를 전송하면 `received: 3, sent: 1, dropped: 0`이다.
- 개선: admission 및 runtime drop 원인별 counter를 별도로 제공하거나 driver와 합산한다. 네트워크 drop과 애플리케이션 drop은 명확히 구분한다.
- 현재 Prometheus/OTel 값만으로는 인증 실패율과 실제 overload를 제대로 경보할 수 없다.

### 8. 드라이버가 STOPPING에서 멈추면 liveness가 계속 정상

- 위치: `packages/nest-webtransport/src/server/webtransport-health.service.ts:24–35`, `packages/driver-rwebtransport/src/driver.ts`의 `handleServerError()/performStop()`
- driver 오류 후 stop이 timeout되면 드라이버는 STOPPING에 남는다. runtime은 이 비동기 오류를 전달받지 않아 RUNNING을 유지할 수 있다.
- health는 runtime RUNNING + driver STOPPED 조합만 사망으로 처리한다.
- **분기 재현:** runtime RUNNING, driver STOPPING 입력에 `alive: true, ready: false`를 확인했다. 영구 고장 상황에서 Kubernetes가 트래픽만 빼고 liveness로 재시작하지 않을 수 있다.
- 개선: terminal driver error를 runtime에 전달하거나 상태 불일치의 지속 시간에 따른 failure 정책을 둔다. 정상 drain 동안의 liveness와 실패한 shutdown은 구분해야 한다.

### 9. Redis 장애 시 인증/핸들러/종료 작업이 무기한 남을 수 있음

- 위치: `examples/production/src/redis-presence.service.ts:15,31–47`, `examples/production/src/realtime.gateway.ts`
- client는 URL만 설정하며 connection/command deadline, offline queue 상한, bounded reconnect, shutdown timeout을 설정하지 않는다. Redis 호출은 `SessionContext.signal`과 연결되어 있지 않다.
- **설정 및 설치된 의존성 코드 확인:** 기본 offline queue를 사용하는 경로가 활성화되어 있고 queue 상한은 지정하지 않았다. 장애가 길어지면 admission timeout 후에도 원래 Redis Promise가 남아 framework의 retained-work/IP 슬롯을 계속 점유할 수 있다. `connect()`/`quit()`도 예제 자체의 전체 시간 제한이 없다.
- 개선: command/connection/종료 deadline, queue 상한, 적절한 offline policy, 장애 시 신규 admission 차단 및 취소 가능한 호출을 설계한다.
- 이 항목은 실제 Redis 장애 주입을 수행한 결과가 아니라 코드와 의존성 설정에 근거한 위험이다.
- 참고: [Redis 공식 production usage](https://redis.io/docs/latest/develop/clients/nodejs/produsage/), [client configuration](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md).

### 10. Redis SET 대기 중 연결이 끊기면 presence 정리를 놓침

- 위치: `examples/production/src/realtime.gateway.ts:30–38`
- `await markConnected()`가 끝난 뒤 abort listener를 등록한다. 대기 중 signal이 이미 abort되면 나중에 등록한 listener는 호출되지 않는다.
- **재현:** markConnected Promise를 보류하고 context를 abort한 다음 Promise를 완료시켰다. `markDisconnected()` 호출은 0회였다.
- 결과: 연결이 없는 사용자의 presence가 TTL 120초까지 남을 수 있다. SET 자체가 offline queue에 남으면 재연결 후 늦게 기록될 수도 있다.
- 개선: abort 상태를 SET 완료 후 다시 검사하고 정리한다. SET/DEL 실행 순서와 중복 정리까지 안전하게 처리한다.

### 11. 초과 패킷마다 로그를 남겨 overload를 로그 부하로 바꿈

- 위치: `packages/nest-webtransport/src/server/webtransport-runtime.ts:649–676`, `examples/production/src/app.module.ts:58`
- rate/size 제한을 초과한 데이터그램마다 JSON 로그를 생성한다. production logger는 `stdout.write()` 반환값에 따른 backpressure나 자체 큐 상한을 처리하지 않는다.
- **정적 확인:** 초과 트래픽이 계속 들어오는 동안 로그 횟수를 제한하는 코드가 없다. 핸들러 실행량이 제한되어도 로그 비용은 수신 패킷 수에 따라 증가한다. 느린 로그 수집 경로에서는 출력 버퍼가 늘어날 수 있다.
- 개선: 원인별 counter와 시간창별 집계/샘플링, bounded logger를 사용한다. 실제 발생 처리량과 메모리 증가량은 이번에 부하 재현하지 않았다.

## 명시적으로 보완해야 할 프로덕션 범위

다음은 버그 재현과 별도로 결정·검증할 운영 요구다.

1. **장기 세션 인증 수명.** JWT exp는 연결 시에만 검사하고 principal에는 만료 시각이 남지 않는다. 계속 활동하는 세션은 토큰 만료 후에도 유지 가능하다. 세션 최대 인증 수명, 재인증, 로그아웃/강제 철회 정책을 정해야 한다. 현재 문서는 인증이 한 번임을 밝히므로 이를 미문서화된 인증 우회로 분류하지 않았다.
2. **서버 전체 작업/메모리 예산.** handler 제한은 세션별이다. 예제의 50,000 세션 × 64 동시 핸들러는 설정상 3,200,000개 작업을 허용한다. pending 한도는 합계 6,400,000개다. 컨테이너 메모리 제한 1Gi와 이 값들이 맞는다는 검증은 없다. 서버 전체 동시 작업, 대기 작업, byte/tenant 예산과 실측에 따른 기본값이 필요하다. 이 수치는 허용량 계산이지 실제 측정값이 아니다.
3. **운영 예제와 인프라 검증.** 기존 CI는 production 예제의 실제 bootstrap 및 Docker image build를 검사하지 않아 2·3번을 놓친다. Redis 장애/복구, rolling restart 중 기존 스트림, 인증 만료, 최대 동시 접속, UDP loss/jitter/MTU/NAT, 인증서 교체, 장시간 soak를 배포 환경에서 검증해야 한다. 이번 60초 시험은 최대 처리 용량이나 수일간 안정성의 근거가 아니다.
4. **오류 진단 경로.** runtime 로그는 일반 Error의 이름만 남기고 message/cause/stack을 모두 제거하며, driver의 비동기 서버 오류는 외부 오류 이벤트 없이 stop으로 이어진다. 비밀값을 제거한 내부 진단 경로가 필요하다. payload/token을 무조건 로그에 추가하라는 의미는 아니다.

## 이번 검증 결과

- 기존 타입 검사 및 예제 타입 검사 통과.
- 기존 unit/virtual integration: 25개 파일, 112개 통과, 1개 건너뜀. 이 실행은 기본 Node 25.9.0에서 수행하여 native compatibility 한 건이 skip되었다.
- 지원 런타임 Node 26.8.1에서 unit/virtual integration 재실행: **25개 파일, 113개 모두 통과, 건너뜀 0**.
- 전체 `bun run check`: 기존 수정 파일 `examples/basic/src/main.ts` 포맷 오류로 lint 단계 실패. 이후 검사들은 별도 실행했다.
- 실제 네이티브 검사는 기본 Node 25에서 runtime 지원 오류로 실행되지 않았다. 설치된 **Node 26.8.1**로 전환하여 다시 검증했다.
- Node 26 실제 QUIC 4건, Chromium 1건, 클라이언트 강제 종료/약 30초 native timeout 1건: 총 6건 통과.
- Node 26의 60초 soak 통과: 3,730회 연결/3,730개 스트림, GC 후 heap 변화 -388,320 bytes, RSS 변화 +10,944,512 bytes. 매 회차 활성 세션/스트림 회수와 readiness를 확인했다. 동시 클라이언트 수는 10개다.
- build 및 5개 패키지 publint 통과.
- 5개 패키지 독립 tarball 설치/public import/Nest bootstrap/TypeScript 검사 통과.
- 추가 재현은 기존 테스트가 놓친 입력과 lifecycle 경로를 별도 Node 스크립트로 실행했다. 애플리케이션 소스를 수정하거나 외부 서비스에 트래픽을 보내지 않았다.

실제 Docker/Kubernetes 배포, 실제 Redis 장애 주입, 원격 CI, 다른 플랫폼 전체 조합과 장기 soak는 이번 검증 범위 밖이다.
