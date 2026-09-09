# v1 프로덕션 준비도와 수정 내역

영문 원문: [v1-readiness.md](v1-readiness.md)

대상: 2026-09-08 작업 트리. 패키지 버전: `1.0.0-rc.1`.

기존 감사(`code-audit-2026-09-08.md`)의 재현 결과를 다시 확인하고, core·Nest 실행 계층·
native adapter·testing·OTel·프로덕션 예제·패키징을 나누어 검토했습니다. 아래는 확인한
결함과 수정 목록입니다. 모든 입력이나 환경에서 결함이 없음을 증명하는 목록은 아닙니다.
기존 감사와 0.1.0 검증 보고서는 과거 상태의 기록으로 보존합니다. 현재 후보 버전의 결과는
이 문서를 기준으로 봅니다.

## 수정한 결함

| 우선순위 | 문제 | 수정과 검증 경로 |
| --- | --- | --- |
| P1 | 요청 범위 전역 Guard/Pipe/Interceptor/Filter의 provider token 조회 실패 | 실제 wrapper token과 소유 module로 조회. useClass/useFactory/useExisting 및 REQUEST 통합 회귀 검사 |
| P1 | 같은 gateway/enhancer가 여러 module에 등록되면 다른 module의 dependency 사용 | Discovery가 provider token과 소유 ModuleRef를 유지. Module별 설정 격리 검사 |
| P1 | 등록된 enhancer factory 실패 시 기본 class 재생성으로 검증을 우회할 수 있음 | 등록 provider failure는 전파. 임의 기본 instance로 바꾸지 않음 |
| P1 | 프로덕션 예제의 type-only import DI로 bootstrap 실패 | 명시적 injection token과 실제 Nest 기동 검사 |
| P1 | Docker build input에 필수 scripts가 빠지고 Node runtime이 불명확 | 지원 Node builder, 전체 workspace input, scripts, production 실행 파일과 build CI 보완 |
| P1 | drain 중 새 incoming stream이 기존 session 전체를 종료 | 취소된 collection과 실제 overflow를 구분. queued/new stream만 reset/stop하고 intake 중단 전 peer에 drain 통지. 실제 QUIC 회귀 검사 |
| P1 | session별 제한만으로 server 전체 실행·대기 작업 수가 크게 증가 | authentication을 포함한 전체 작업 reservation/concurrency 제한. 연결이 끊긴 실제 작업이 끝날 때까지 reservation 유지 |
| P2 | memory/stream 전체 budget 부재 | 전체 관리 stream 수와 retained datagram byte 제한. scheduler 대기·실행 중 byte도 포함 |
| P2 | 작은 Uint8Array/Buffer view가 큰 원본 buffer를 계속 보관 | 정확한 길이의 Uint8Array 복사. drop-oldest는 교체 후 순사용량으로 검사 |
| P2 | 직접 I/O를 처리하는 session은 활동 중에도 idle 종료 | context.touch() 제공, idleTimeoutMs:0 명시적 수동 정책. 지속 통신 및 이후 idle 만료 검사 |
| P2 | 빈 resolver route에서 fallback을 두 번 호출 | 빈 route를 unnamed fallback 한 번으로 정규화 |
| P2 | resolver/guard/pipe/DI 완료 전에 끊긴 session에서 뒤늦게 handler 실행 | 비동기 단계 이후 및 handler 사이 취소 검사 |
| P2 | 인증 거절과 framework datagram 폐기가 운영 지표에 없음 | getRuntimeStats(), 원인별 제한된 label, OTel/Prometheus 별도 runtime 지표 |
| P2 | 과부하를 매 packet log로 증폭 | runtime log 초당 상한 및 suppression counter. 예제 stdout backpressure 대응 |
| P2 | driver가 STOPPING에 멈춰도 runtime liveness 정상 | RUNNING runtime과 비정상 driver 상태 불일치 시 unhealthy |
| P2 | 일반 오류와 비동기 driver failure의 내부 진단 경로 부족 | 선택적 private diagnostics callback. 기본 log에 secret/stack을 추가하지 않음 |
| P2 | Native write/close의 session failure를 성공으로 반환 | 호출자에게 failure를 전달하고 stream state/lock 정리 검사 |
| P2 | 상태 조회마다 모든 connection에 native 통계 요청 | 조회 간격과 동시 수집 수 제한, cache된 snapshot 사용 |
| P2 | Redis offline queue/command/connect/shutdown 작업이 장기 잔류 | Offline buffering 비활성화, queue 상한과 명시적 deadline, bounded reconnect, failure health 반영 |
| P2 | Presence SET 대기 중 disconnect 시 DEL 누락 | SET 후 signal 재확인, failure/중복 cleanup 처리 |
| P2 | 장기 연결이 JWT 만료 후에도 유지 | 검증된 만료 시각 유지, session 만료 종료 및 timer 정리 |
| P2 | Test transport에서 backpressure 중 abort 교착, 양방향 통계 혼합 | Write 취소와 lifecycle 정리, server 관점 송수신 통계, Buffer 복사 회귀 검사 |
| P2 | Browser demo의 무제한 broadcast 대기·응답 축적·대형 단방향 확인·HTTP 종료 지연 | 수신자별 queue/송신 deadline, browser 1 MiB 한도, 작은 preview/error response, HTTP 종료 상한, ticket 503/정확한 만료, payload log 제거 |
| P2 | OTel exception message/stack에 인증 정보가 포함될 수 있음 | 기본 exception detail 비식별화, 상세 기록은 명시적 opt-in |

## 주요 기본값과 사용 경계

- Runtime 및 native session 상한: 1,000. 실측 최대 처리량을 의미하지 않습니다.
- Runtime 전체 동시 작업 256, 추가 대기 작업 1,024. Authentication도 이 budget을 공유합니다.
- Runtime 전체 관리 incoming stream 2,048, retained datagram byte 16 MiB
- 기본 log는 runtime당 초당 100개입니다. 비동기 log callback의 미완료 record 수도 같은 상한으로 제한합니다. 상세 원인 수치는 log 제한과 별도로 누적합니다.
- 수동 incoming/outgoing stream의 concurrency·drain·lifetime은 app이 관리합니다. 성공한 I/O 후 context.touch()를 호출하거나 idleTimeoutMs:0과 자체 idle 종료 정책을 사용합니다.
- 임의의 사용자 Promise를 강제 중단하지 않습니다. Disconnect 후 미완료 작업의 budget을 계속 유지합니다.
- Native library·QUIC·OS 내부 memory까지 위 JavaScript budget이 제한하지는 않습니다.
- Redis나 authentication server 같은 외부 I/O에는 app 자체의 cancellation과 deadline이 필요합니다.

## 검증 결과

환경: macOS arm64, Node 26.8.1 및 24.20.0, Bun 1.3.12. 최종 code 기준입니다.

| 검사 | 결과 |
| --- | --- |
| Node 26 전체 release:check | 통과: lint·type·example type·unit/integration·build·publint·native·Chromium·강제 종료·soak·독립 설치 |
| Unit / virtual / 예제 회귀 검사 | **37개 file, 175개 모두 통과** — Node 24와 26, skip 없음 |
| 실제 native QUIC | **5개 통과** — Node 24·26. 세 channel, authentication/Origin, churn/flood, drain 통지와 기존 stream 완료 |
| 실제 Chromium | Node 24·26 모두 certificate pinning, 거절, datagram/bidi/uni 통과 |
| 강제 종료 | Node 26 별도 client 강제 종료 후 약 30초 native idle timeout, server 생존 및 session 회수 통과 |
| 60초 native soak | **3,680회 연결 / 3,677개 stream**, 매 회차 resource 회수 확인. GC 후 heap -1,012,904 bytes, RSS -2,129,920 bytes |
| 독립 설치 | 5개 tarball을 저장소 밖에서 설치, public import, Nest 기동·종료, skipLibCheck:false type 검사 통과 |
| Package version | 5개 manifest와 lockfile 1.0.0-rc.1 동기화, frozen install 통과. Packed workspace dependency도 실제 manifest version과 비교 |
| Dependency 취약점 조회 | bun audit --json: {}, 종료 code 0 |
| 변경 검증 | Biome, type 검사, git diff --check 통과 |
| Docker | Daemon에 연결할 수 없어 local image build는 실행하지 않음. Clean image build 및 runtime import CI 추가 |

Soak는 round마다 동시 client 10개와 64 KiB echo 및 전송 중 disconnect를 포함합니다. 최대
동시 접속 capacity나 24–72시간 안정성의 증거로 사용하지 않습니다. Redis failure 검사는
mock client로 timeout/queue/cancellation/lifecycle을 재현했으며 실제 Redis server failure
주입은 아직 실행하지 않았습니다. Remote CI matrix와 Kubernetes deployment도 이 local 결과에
포함하지 않습니다.

5개 배포용 tarball과 SHA256SUMS는 `.cache/release/1.0.0-rc.1/`에 생성했습니다. Bundle은
같은 directory의 `nest-webtransport-1.0.0-rc.1.zip`입니다. npm에는 게시하지 않았습니다.
기존 `examples/basic/src/main.ts`의 사용자 수정은 유지하고 저장소 형식으로 정리했습니다.

## 정식 버전 승격과 배포 전 남은 검증

`1.0.0-rc.1`은 local에서 검증한 v1 후보입니다. npm 게시·Git commit·tag·remote push는 하지
않습니다. 정식 `1.0.0` 승격 전에는 대상 platform CI와 다음 운영 검증을 완료해야 합니다.

1. 실제 Docker image build와 대상 Kubernetes/UDP ingress의 rolling restart
2. 실제 Redis failure/recovery 및 network response 정지 상황, certificate 교체
3. 실제 workload 규모에서 CPU·native/JS memory·file descriptor와 24–72시간 soak
4. UDP loss·jitter·MTU·NAT·reconnect와 browser 지원 범위
5. App별 권한 철회/distributed logout, tenant budget, outgoing stream lifetime, npm 소유권과 후보 consumer API 검증

`rwebtransport` 0.2.2는 동적 pre-CONNECT authentication을 제공하지 않습니다. 이 기능이
요구되는 deployment에는 다른 driver 또는 QUIC-aware admission layer가 필요합니다. 현재
authentication은 connection이 surfaced된 직후 검사하고 실패하면 session을 닫습니다.
[보안 모델](security.ko.md)과 [이관·출시 절차](releasing.ko.md)를 참고하세요.
