# v1 프로덕션 준비도와 수정 내역

대상: 2026-09-08 작업 트리. 패키지 버전: `1.0.0-rc.1`.

기존 감사(`code-audit-2026-09-08.md`)의 재현 결과를 다시 확인하고, core·Nest 실행 계층·native
adapter·testing·OTel·프로덕션 예제·패키징을 나누어 검토했다. 아래는 확인한 결함과 수정 목록이다.
모든 입력이나 환경에서 결함이 없음을 증명하는 목록은 아니다. 기존 감사와 0.1.0 검증 보고서는
과거 상태의 기록으로 보존한다. 현재 후보 버전의 결과는 이 문서를 기준으로 본다.

## 수정한 결함

| 우선순위 | 문제 | 수정과 검증 경로 |
| --- | --- | --- |
| P1 | 요청 범위 전역 Guard/Pipe/Interceptor/Filter의 provider 토큰 조회 실패 | 실제 wrapper token과 소유 모듈로 조회. useClass/useFactory/useExisting 및 REQUEST 통합 회귀 검사 |
| P1 | 같은 gateway/enhancer가 여러 모듈에 등록되면 다른 모듈의 의존성 사용 | discovery가 provider 토큰과 소유 ModuleRef를 유지. 모듈별 설정 격리 검사 |
| P1 | 등록된 enhancer factory 실패 시 기본 클래스 재생성으로 검증을 우회할 수 있음 | 등록 provider 실패는 전파. 임의 기본 인스턴스로 바꾸지 않음 |
| P1 | 프로덕션 예제의 type-only import DI로 bootstrap 실패 | 명시적 주입 토큰과 실제 Nest 기동 검사 |
| P1 | Docker build 입력에 필수 scripts가 빠지고 Node 런타임이 불명확 | 지원 Node builder, 전체 workspace 입력, scripts, production 실행 파일과 빌드 CI 보완 |
| P1 | drain 중 새 incoming stream이 기존 세션 전체를 종료 | 취소된 collection과 실제 overflow를 구분. queued/new stream만 reset/stop하고 intake 중단 전 peer에 drain 통지. 실제 QUIC 회귀 검사 |
| P1 | 세션별 제한만으로 서버 전체 실행·대기 작업 수가 크게 증가 | 인증을 포함한 전체 작업 예약/동시성 제한. 연결이 끊긴 실제 작업이 끝날 때까지 예약 유지 |
| P2 | 메모리/스트림 전체 예산 부재 | 전체 관리 스트림 수와 데이터그램 retained bytes 제한. scheduler 대기/실행 중 byte도 포함 |
| P2 | 작은 Uint8Array/Buffer view가 큰 원본 버퍼를 계속 보관 | 정확한 길이의 Uint8Array 복사. drop-oldest는 교체 후 순사용량으로 검사 |
| P2 | 직접 I/O를 처리하는 세션은 활동 중에도 idle 종료 | context.touch() 제공, idleTimeoutMs:0 명시적 수동 정책. 지속 통신 및 이후 idle 만료 검사 |
| P2 | 빈 resolver route에서 fallback을 두 번 호출 | 빈 route를 unnamed fallback 한 번으로 정규화 |
| P2 | resolver/guard/pipe/DI 완료 전에 끊긴 세션에서 뒤늦게 핸들러 실행 | 비동기 단계 이후 및 핸들러 사이 취소 검사 |
| P2 | 인증 거절과 프레임워크 데이터그램 폐기가 운영 지표에 없음 | getRuntimeStats(), 원인별 제한된 라벨, OTel/Prometheus 별도 runtime 지표 |
| P2 | 과부하를 매 패킷 로그로 증폭 | runtime 로그 초당 상한 및 억제 카운터. 예제 stdout backpressure 대응 |
| P2 | driver가 STOPPING에 멈춰도 runtime liveness 정상 | RUNNING runtime과 비정상 driver 상태 불일치 시 unhealthy |
| P2 | 일반 오류와 비동기 드라이버 실패의 내부 진단 경로 부족 | 선택적 private diagnostics callback. 기본 로그에 secret/stack을 추가하지 않음 |
| P2 | 네이티브 write/close의 세션 실패를 성공으로 반환 | 호출자에게 실패를 전달하고 스트림 상태/잠금 정리 검사 |
| P2 | 상태 조회마다 모든 연결에 네이티브 통계 요청 | 조회 간격과 동시 수집 수 제한, 캐시된 snapshot 사용 |
| P2 | Redis offline queue/command/connect/shutdown 작업이 장기 잔류 | offline buffering 비활성화, 큐 상한과 명시적 deadline, bounded reconnect, 실패 health 반영 |
| P2 | presence SET 대기 중 disconnect 시 DEL 누락 | SET 후 signal 재확인, 실패/중복 cleanup 처리 |
| P2 | 장기 연결이 JWT 만료 후에도 유지 | 검증된 만료 시각 유지, 세션 만료 종료 및 timer 정리 |
| P2 | 테스트 transport에서 backpressure 중 abort 교착, 양방향 통계 혼합 | write 취소와 lifecycle 정리, 서버 관점 송수신 통계, Buffer 복사 회귀 검사 |
| P2 | 브라우저 데모의 무제한 broadcast 대기·응답 축적·대형 단방향 확인·HTTP 종료 지연 | 수신자별 큐/송신 deadline, 브라우저 1 MiB 한도, 작은 preview/오류 응답, HTTP 종료 상한, ticket 503/정확한 만료, payload 로그 제거 |
| P2 | OTel exception message/stack에 인증 정보가 포함될 수 있음 | 기본 예외 상세 비식별화, 상세 기록은 명시적 opt-in |

## 주요 기본값과 사용 경계

- runtime 및 native session 상한: 1,000. 실측 최대 처리량을 의미하지 않는다.
- runtime 전체 동시 작업 256, 추가 대기 작업 1,024. 인증도 이 예산을 공유한다.
- runtime 전체 관리 incoming stream 2,048, retained datagram bytes 16 MiB.
- 기본 로그는 runtime당 초당 100개. 비동기 로그 콜백의 미완료 기록 수도 같은 상한으로 제한한다. 상세 원인 수치는 로그 제한과 별도로 누적한다.
- 수동 incoming/outgoing stream의 동시성·drain·수명은 앱이 관리한다. 성공한 I/O 후 context.touch()를
  호출하거나 idleTimeoutMs:0과 자체 idle 종료 정책을 사용한다.
- 임의의 사용자 Promise를 강제 중단하지 않는다. disconnect 후 미완료 작업의 예산을 계속 유지한다.
- 네이티브 라이브러리·QUIC·OS 내부 메모리까지 위 JavaScript 예산이 제한하지는 않는다.
- Redis나 인증 서버 같은 외부 I/O에는 앱 자체의 취소와 deadline이 필요하다.

## 검증 결과

환경: macOS arm64, Node 26.8.1 및 24.20.0, Bun 1.3.12. 최종 코드 기준.

| 검사 | 결과 |
| --- | --- |
| Node 26 전체 release:check | 통과: lint·타입·예제 타입·unit/integration·빌드·publint·native·Chromium·강제 종료·soak·독립 설치 |
| unit / virtual / 예제 회귀 검사 | **37개 파일, 175개 모두 통과** — Node 24와 26, 건너뜀 없음 |
| 실제 native QUIC | **5개 통과** — Node 24·26. 세 채널, 인증/Origin, churn/flood, drain 통지와 기존 스트림 완료 |
| 실제 Chromium | Node 24·26 모두 certificate pinning, 거절, datagram/bidi/uni 통과 |
| 강제 종료 | Node 26 별도 클라이언트 강제 종료 후 약 30초 native idle timeout, 서버 생존 및 세션 회수 통과 |
| 60초 native soak | **3,680회 연결 / 3,677개 스트림**, 매 회차 자원 회수 확인. GC 후 heap -1,012,904 bytes, RSS -2,129,920 bytes |
| 독립 설치 | 5개 tarball을 저장소 밖에서 설치, public import, Nest 기동·종료, skipLibCheck:false 타입 검사 통과 |
| 패키지 버전 | 5개 manifest와 lockfile 1.0.0-rc.1 동기화, frozen install 통과. packed workspace 의존성도 실제 manifest 버전과 비교 |
| 의존성 취약점 조회 | bun audit --json: {}, 종료 코드 0 |
| 변경 검증 | Biome, 타입 검사, git diff --check 통과 |
| Docker | daemon에 연결할 수 없어 로컬 이미지 빌드 미실행. clean image build 및 runtime import CI 추가 |

Soak는 회차당 10개 동시 클라이언트와 64 KiB echo 및 전송 중 disconnect를 포함한다.
최대 동시 접속 용량이나 24–72시간 안정성의 증거로 사용하지 않는다. Redis 장애 검사는
mock client로 timeout/queue/cancellation/lifecycle을 재현했으며 실제 Redis 서버 장애 주입은
아직 실행하지 않았다. 원격 CI matrix와 Kubernetes 배포도 이 로컬 결과에 포함하지 않는다.

5개 배포용 tarball과 SHA256SUMS는 `.cache/release/1.0.0-rc.1/`에 생성했다.
묶음은 같은 디렉터리의 `nest-webtransport-1.0.0-rc.1.zip`이다. npm에는 게시하지 않았다.
기존 `examples/basic/src/main.ts`의 사용자 수정은 유지하고 저장소 형식으로 정리했다.

## 정식 버전 승격과 배포 전 남은 검증

`1.0.0-rc.1`은 로컬에서 검증한 v1 후보다. npm 게시·Git 커밋·tag·원격 push는 하지 않는다.
정식 `1.0.0` 승격 전에는 대상 플랫폼 CI와 다음 운영 검증을 완료해야 한다.

1. 실제 Docker image build와 대상 Kubernetes/UDP ingress의 rolling restart.
2. 실제 Redis 장애/복구 및 네트워크 응답 정지 상황, 인증서 교체.
3. 실제 워크로드 규모에서 CPU·native/JS 메모리·file descriptor와 24–72시간 soak.
4. UDP 손실·지터·MTU·NAT·재연결과 브라우저 지원 범위.
5. 앱별 권한 철회/분산 logout, tenant 예산, outgoing stream 수명, npm 소유권과 후보 소비자 API 검증.

rwebtransport 0.2.2는 동적 pre-CONNECT 인증을 제공하지 않는다. 이 기능이 요구되는 배포는
다른 드라이버 또는 QUIC-aware admission 계층이 필요하다. 현재 인증은 연결이 surfaced된 직후
검사하고 실패 시 세션을 닫는다. [보안 모델](security.md)과 [이관/출시 절차](releasing.md)를 참고한다.
