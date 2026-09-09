# 코드 및 프로덕션 준비도 감사

영문 원문: [code-audit-2026-09-08.md](code-audit-2026-09-08.md)

현재 작업 트리 기준입니다. 분석 대상은 core, Nest 실행 계층, rwebtransport adapter와
vendored JavaScript, testing, OTel, 예제, deployment·validation configuration입니다.
Source 수정 없이 기존 검사와 별도 재현을 수행했습니다. 기존 변경
`examples/basic/src/main.ts`는 보존했습니다.

판정: 기본 전송 기능과 기존 release 검사는 통과하지만, **production example 기동과 Docker
build, request-scoped global enhancer, 정상 shutdown 처리에는 먼저 수정해야 할 결함이
있습니다.** 아래 목록은 이번 검토에서 확인한 문제이며, 모든 결함이 없음을 증명하지 않습니다.

P1은 해당 기능 사용 또는 deployment를 막는 문제, P2는 특정 조건에서 data 처리·복구·운영
안정성을 해치는 문제로 분류했습니다. Static 근거만 있는 risk와 직접 재현한 결과를 구분합니다.

## P1 — 먼저 수정할 문제

### 1. Request-scoped global Guard/Pipe/Interceptor/Filter의 DI token이 잘못됨

- 위치: `packages/nest-webtransport/src/execution/execution-pipeline.ts:252–273`
- `resolveRequestEnhancers()`가 Nest의 실제 wrapper 대신 `wrapper.metatype`을
  `moduleRef.resolve()`에 넘깁니다.
- `APP_GUARD`의 `useClass` 등록은 별도 token `APP_GUARD (UUID: ...)`으로 저장되므로
  해당 class 자체는 조회되지 않습니다. `useFactory`도 factory function을 provider token으로
  조회하는 문제가 생깁니다.
- **재현:** `@Injectable({ scope: Scope.REQUEST })` Guard를
  `{ provide: APP_GUARD, useClass: Guard }`로 등록했습니다. 항상 `true`를 반환하는
  Guard인데도 `@OnSession()` 호출 0회와 session `CLOSED`를 확인했습니다. 원인은
  `Nest could not find Guard element`입니다. Factory 방식도 동일했습니다.
- Guard 외 다른 global request enhancer도 같은 function을 사용합니다. Session handler가
  없다면 event 처리 시 실패합니다.
- 개선: 등록된 wrapper의 token/host module/context로 실제 instance를 로드합니다.
  useClass/useFactory/useExisting와 REQUEST injection을 포함한 통합 검사가 필요합니다.

### 2. Production example이 dependency를 주입받지 못해 기동 실패

- 위치: `examples/production/src/realtime.gateway.ts:17–22`,
  `examples/production/src/operations-server.service.ts:8–22`
- Constructor DI에 사용하는 `RedisPresenceService`와 `WebTransportHealthService`를
  `import type`으로 가져오면서 명시적인 `@Inject()`를 사용하지 않습니다.
- TypeScript build는 성공하지만 생성된 `design:paramtypes`는 Gateway에서 `[Function]`,
  OperationsServer에서 `[Object, Function, Function]`입니다.
- **재현:** Build한 Gateway와 Redis mock provider로 실제 Nest testing module을 compile하면
  `Nest can't resolve dependencies of the RealtimeGateway ... Function at index [0]` 오류가
  발생합니다.
- 개선: Runtime class import와 명시적 injection token을 사용합니다. Type 검사만으로는
  발견되지 않으므로 실제 example bootstrap 검사를 추가해야 합니다.

### 3. Docker build 단계에 필수 scripts directory가 없음

- 위치: `examples/production/Dockerfile:3–8`, root `package.json`의 `build`
- Build stage는 manifest, tsconfig, packages, production example만 copy합니다. 그런데
  `bun run build`는 먼저 `node scripts/vendor-rwebtransport.mjs`를 실행합니다.
- **Static 확인:** Image에 `/app/scripts/vendor-rwebtransport.mjs`를 넣는 COPY나 생성
  단계가 없습니다. Dependency 설치가 성공해도 이 build 단계는 진행할 수 없습니다.
- 개선: Build에 필요한 scripts와 일관된 workspace input을 포함합니다. Build stage에도
  지원 Node version을 명시하고 clean-context Docker build를 검증해야 합니다.
- Docker daemon을 이용한 실제 image build는 이번에 수행하지 않았습니다.

### 4. Drain 중 새 stream이 도착하면 기존 작업까지 즉시 끊음

- 위치: `packages/nest-webtransport/src/server/webtransport-runtime.ts:285–286,1234–1251`,
  `packages/driver-rwebtransport/vendor/rwebtransport.mjs:1282–1295`, 생성 원본
  `scripts/vendor-rwebtransport.mjs`
- Runtime은 drain 시작 시 incoming reader를 cancel합니다. Vendored `onBidi/onUni`는
  취소된 collection의 `desiredSize`를 capacity 초과로 판단하여 session 전체를 close합니다.
- Driver의 `session.drain()` 통지는 runtime이 자기 drain을 끝내고 `driver.stop()`에
  도달한 뒤 실행되므로 이 구간을 보호하지 못합니다.
- **실제 QUIC 재현:** 처리 중인 uni handler를 150 ms 지연시킨 뒤 종료를 시작하고
  `DRAINING` 상태에서 새 uni stream을 보냈습니다. 기존 handler가 끝나기 전에
  `{ closeCode: 257, reason: 'incoming stream capacity exceeded' }`로 연결이 닫혔습니다.
- 개선: 취소·종료 상태와 실제 queue overflow를 구별합니다. Drain 중 새 stream만 거절하고
  기존 stream은 마치게 하며, 가능하면 intake 중단 전에 drain 통지를 보냅니다.

## P2 — 런타임 및 운영 문제

### 5. 수동으로 소비하는 session은 계속 통신해도 idle timeout으로 닫힘

- 위치: `packages/nest-webtransport/src/server/webtransport-runtime.ts:1161–1174`,
  reader ownership 관련 README
- `touch()`는 framework pump와 decorator-managed stream 추적에서만 갱신됩니다.
  `@OnSession()`에서 직접 incoming collection을 읽는 공식 지원 경로에는 activity tracking
  또는 public touch API가 없습니다. 송신 전용 작업도 같은 제약이 있습니다.
- **재현:** Datagram decorator 없이 `@OnSession()`에서 수동 datagram reader를 시작했습니다.
  약 10 ms마다 data를 보내 6개를 실제로 읽었지만 `idleTimeoutMs: 80` 부근에 code 259,
  `Session idle timeout`으로 닫혔습니다.
- 개선: Adapter의 실제 activity를 runtime에 전달하거나 명시적인 activity 갱신 API/idle
  policy를 제공합니다. 외부 작업의 lifecycle을 application이 관리한다는 문서만으로
  정상 traffic의 강제 종료를 해결할 수 없습니다.

### 6. Resolver가 빈 route를 반환하면 fallback handler가 두 번 실행됨

- 위치: `packages/nest-webtransport/src/routing/gateway-registry.ts:45–62,101–106`
- Registry key가 `undefined`와 `''`를 동일하게 취급하지만, `find`는 빈 문자열을 exact
  route로 조회한 뒤 같은 fallback array를 다시 합칩니다.
- **재현:** Fallback 한 개를 등록하고 `find('/a', 'datagram', '')`을 호출하면 결과 길이가 2입니다.
- Decorator는 빈 route를 금지하지만 user resolver 결과에는 같은 validation이 없어 도달할
  수 있는 경로입니다. 저장·전송 같은 부수 효과가 중복 실행될 수 있습니다.
- 개선: Resolver 반환값의 빈 route를 거부·정규화하고 exact/fallback 중복 합산을 방지합니다.

### 7. 인증 거절과 runtime datagram 폐기가 운영 지표에서 빠짐

- 위치: Runtime의 `validateSession()`/`authenticateAndRunSessionHandlers()`/
  `pumpDatagrams()`, `packages/driver-rwebtransport/src/driver.ts`의 counter,
  `packages/otel/src/metrics.ts`, `examples/production/src/operations-server.service.ts`
- Nest가 authentication·Origin·resource limit 등으로 session을 닫아도 driver의
  `sessionsRejected`가 증가하지 않습니다. Rate/size/queue limit으로 폐기한 datagram도
  driver drop metric에 전달되지 않습니다.
- **실제 QUIC 재현:** 잘못된 authentication으로 code 256 종료 후 rejected counter는 0입니다.
  초당 1개 제한에 3개를 보내면 `received: 3, sent: 1, dropped: 0`입니다.
- 개선: Admission 및 runtime drop 원인별 counter를 별도로 제공하거나 driver와 합산합니다.
  Network drop과 application drop은 명확히 구분해야 합니다.
- 현재 Prometheus/OTel 값만으로는 authentication failure rate과 실제 overload를 제대로
  alert할 수 없습니다.

### 8. Driver가 STOPPING에서 멈추면 liveness가 계속 정상

- 위치: `packages/nest-webtransport/src/server/webtransport-health.service.ts:24–35`,
  `packages/driver-rwebtransport/src/driver.ts`의 `handleServerError()/performStop()`
- Driver error 후 stop이 timeout되면 driver는 STOPPING에 남습니다. Runtime은 이 비동기
  오류를 전달받지 않아 RUNNING을 유지할 수 있습니다.
- Health는 runtime RUNNING + driver STOPPED 조합만 사망으로 처리합니다.
- **분기 재현:** Runtime RUNNING, driver STOPPING 입력에서 `alive: true, ready: false`를
  확인했습니다. 영구 고장 상황에서 Kubernetes가 traffic만 빼고 liveness로 재시작하지
  않을 수 있습니다.
- 개선: Terminal driver error를 runtime에 전달하거나 상태 불일치가 지속되는 시간에 따른
  failure policy를 둡니다. 정상 drain 중 liveness와 실패한 shutdown은 구분해야 합니다.

### 9. Redis 장애 시 authentication/handler/shutdown 작업이 무기한 남을 수 있음

- 위치: `examples/production/src/redis-presence.service.ts:15,31–47`,
  `examples/production/src/realtime.gateway.ts`
- Client는 URL만 설정하며 connection/command deadline, offline queue 상한, bounded
  reconnect, shutdown timeout을 설정하지 않습니다. Redis 호출은 `SessionContext.signal`과
  연결되어 있지 않습니다.
- **설정 및 설치된 dependency 확인:** 기본 offline queue 경로가 활성화되어 있고 queue
  상한은 지정하지 않았습니다. 장애가 길어지면 admission timeout 후에도 원래 Redis
  Promise가 남아 framework retained-work/IP slot을 계속 점유할 수 있습니다. `connect()`/
  `quit()`도 example 자체의 전체 time limit이 없습니다.
- 개선: Command/connection/shutdown deadline, queue 상한, 적절한 offline policy, 장애 시
  신규 admission 차단, 취소 가능한 호출을 설계합니다.
- 이 항목은 실제 Redis failure injection 결과가 아니라 code와 dependency 설정에 근거한
  risk입니다.
- 참고: [Redis 공식 production usage](https://redis.io/docs/latest/develop/clients/nodejs/produsage/),
  [client configuration](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md)

### 10. Redis SET 대기 중 연결이 끊기면 presence 정리를 놓침

- 위치: `examples/production/src/realtime.gateway.ts:30–38`
- `await markConnected()`가 끝난 뒤 abort listener를 등록합니다. 대기 중 signal이 이미
  abort되면 나중에 등록한 listener는 호출되지 않습니다.
- **재현:** `markConnected` Promise를 보류하고 context를 abort한 다음 Promise를 완료시켰습니다.
  `markDisconnected()` 호출은 0회였습니다.
- 결과: 연결이 없는 user의 presence가 TTL 120초까지 남을 수 있습니다. SET 자체가 offline
  queue에 남으면 reconnect 후 늦게 기록될 수도 있습니다.
- 개선: SET 완료 후 abort 상태를 다시 검사하고 정리합니다. SET/DEL 실행 순서와 중복 cleanup까지
  안전하게 처리해야 합니다.

### 11. 초과 packet마다 log를 남겨 overload를 log 부하로 바꿈

- 위치: `packages/nest-webtransport/src/server/webtransport-runtime.ts:649–676`,
  `examples/production/src/app.module.ts:58`
- Rate/size limit을 초과한 datagram마다 JSON log를 생성합니다. Production logger는
  `stdout.write()` 반환값에 따른 backpressure나 자체 queue 상한을 처리하지 않습니다.
- **Static 확인:** 초과 traffic이 계속 들어오는 동안 log 횟수를 제한하는 code가 없습니다.
  Handler 실행량이 제한되어도 log 비용은 수신 packet 수에 따라 증가합니다. 느린 log 수집
  경로에서는 output buffer가 늘어날 수 있습니다.
- 개선: 원인별 counter와 시간창별 집계·sampling, bounded logger를 사용합니다. 실제 발생
  처리량과 memory 증가량은 이번에 부하 재현하지 않았습니다.

## 명시적으로 보완해야 할 프로덕션 범위

다음은 bug 재현과 별도로 결정·검증할 운영 요구입니다.

1. **장기 session authentication 수명.** JWT exp는 connection 시에만 검사하고 principal에는
   만료 시각이 남지 않습니다. 계속 활동하는 session은 token 만료 후에도 유지될 수 있습니다.
   Session 최대 authentication lifetime, re-authentication, logout/강제 철회 policy를 정해야
   합니다. 현재 문서는 authentication이 한 번임을 밝히므로 이를 미문서화된 authentication
   우회로 분류하지 않았습니다.
2. **Server 전체 작업/memory budget.** Handler limit은 session별입니다. Example의
   50,000 session × 64 동시 handler는 설정상 3,200,000개 작업을 허용합니다. Pending 한도는
   합계 6,400,000개입니다. Container memory limit 1 Gi와 이 값들이 맞는다는 검증은 없습니다.
   Server 전체 동시 작업, 대기 작업, byte/tenant budget과 실측에 따른 기본값이 필요합니다.
   이 수치는 허용량 계산이지 실제 측정값이 아닙니다.
3. **운영 예제와 infrastructure 검증.** 기존 CI는 production example의 실제 bootstrap 및
   Docker image build를 검사하지 않아 2·3번을 놓칩니다. Redis 장애/복구, rolling restart 중
   기존 stream, authentication 만료, 최대 동시 접속, UDP loss/jitter/MTU/NAT, certificate
   교체, 장시간 soak를 deployment environment에서 검증해야 합니다. 이번 60초 시험은 최대
   처리 용량이나 수일간 안정성의 근거가 아닙니다.
4. **Error diagnostic 경로.** Runtime log는 일반 Error의 이름만 남기고 message/cause/stack을
   모두 제거하며, driver의 비동기 server error는 외부 error event 없이 stop으로 이어집니다.
   Secret을 제거한 내부 diagnostic 경로가 필요합니다. Payload/token을 무조건 log에 추가하라는
   의미는 아닙니다.

## 이번 검증 결과

- 기존 type 검사 및 example type 검사 통과
- 기존 unit/virtual integration: 25개 file, 112개 통과, 1개 skip. 이 실행은 기본 Node
  25.9.0에서 수행하여 native compatibility 한 건이 skip됨
- 지원 runtime Node 26.8.1에서 unit/virtual integration 재실행: **25개 file, 113개 모두
  통과, skip 0**
- 전체 `bun run check`: 기존 수정 file `examples/basic/src/main.ts` format 오류로 lint
  단계 실패. 이후 검사는 별도 실행
- 실제 native 검사는 기본 Node 25에서 runtime 지원 오류로 실행되지 않음. 설치된 **Node
  26.8.1**로 전환하여 다시 검증
- Node 26 실제 QUIC 4건, Chromium 1건, client 강제 종료/약 30초 native timeout 1건:
  총 6건 통과
- Node 26의 60초 soak 통과: 3,730회 connection/3,730개 stream, GC 후 heap 변화
  -388,320 bytes, RSS 변화 +10,944,512 bytes. 매 회차 active session/stream 회수와
  readiness를 확인. 동시 client 수는 10개
- Build 및 5개 package publint 통과
- 5개 package 독립 tarball install/public import/Nest bootstrap/TypeScript 검사 통과
- 추가 재현은 기존 test가 놓친 input과 lifecycle path를 별도 Node script로 실행했습니다.
  Application source를 수정하거나 외부 service에 traffic을 보내지 않았습니다.

실제 Docker/Kubernetes deployment, 실제 Redis failure injection, remote CI, 다른 platform
전체 조합과 장기 soak는 이번 검증 범위 밖입니다.
