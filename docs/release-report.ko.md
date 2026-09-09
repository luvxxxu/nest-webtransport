# 0.1.0 출시 준비 검증 보고서

영문 원문: [release-report.md](release-report.md)

검증일: 2026-09-07. 대상: 현재 작업 트리의 core, Nest, native driver, testing, OTel package.

## 판정

발견하고 재현한 출시 차단 결함을 수정했으며, **아래 검증 환경과 범위에서 0.1.0 공개 배포용
package를 준비했습니다.** npm 게시·Git commit·원격 push는 수행하지 않았습니다. 기존 작업
트리의 변경도 보존했습니다. 모든 환경에서 결함이 없다는 보증이나 1.0.0 프로덕션 인증을
의미하지 않습니다.

## 수정한 문제

| 우선순위 | 문제와 재현 | 수정 및 회귀 검증 |
| --- | --- | --- |
| P1 | `maxSessions: 1`인데 timeout 후 authentication 작업 4개가 남음 | 실제 authentication/session 초기화 Promise가 끝날 때까지 global/IP slot 유지. Timeout·연결 해제 두 경로 검사 |
| P1 | Client process를 죽이면 약 30초 뒤 native timeout의 orphan Promise rejection 발생 | Upstream `finally` cleanup code를 성공·실패 양쪽을 처리하는 `then`으로 변경. 별도 process 강제 종료 후 server 생존 확인 |
| P1 | 멈춘 handler 뒤로 1,000개의 완료 stream이 계속 쌓임 | Upstream-facing stream queue 각 256개, session queue 1,024개 상한. 초과 session 종료와 정상 server 유지 검사 |
| P1 | Native session/미완료 callback에 독립된 용량 제한이 없음 | `maxSessions`, `maxPendingSessionCallbacks` 추가. 연결이 닫혀도 남은 callback 제한 검사 |
| P1 | Driver의 실제 native close가 멈추면 종료 시간이 제한되지 않음 | 전체 종료 대기에 deadline/abort 적용. 실패 시 `STOPPING` 유지 및 종료 완료 후 retry 검사 |
| P2 | Write 작업이 없는 stream에서 peer error를 놓치고 lock을 유지 | Native reader/writer 종료 관찰, 부모 session abort 전파, idempotent reset/stop. 양방향 reset error 보존 |
| P2 | Datagram idle error 및 close가 wrapper에 즉시 반영되지 않음 | Native 종료 관찰, wrapper error 전파, buffer 폐기와 reader/writer lock 해제 검사 |
| P2 | Native server가 예상 없이 끝나도 RUNNING/정상 liveness로 보일 수 있음 | Native closed 감시 및 driver failure 시 health 반영 |
| P2 | 상속한 gateway method의 parameter decorator를 잃음 | Method를 실제 선언한 prototype에서 metadata 조회. 상속과 session별 DI 검사 |
| P1 | OTel path attribute에 URL query의 authentication ticket이 포함됨 | Query/fragment 제거 및 attribute에 secret이 없는지 검사 |
| P2 | OTel span context 밖에서 실제 Observable subscription 실행 | Span context 안에서 subscribe. Handler 실행 시 context 확인 |
| P2 | Node 범위를 넘는 timeout이 1ms로 바뀔 수 있고 queue size가 runtime에서 실패 | Timer/queue 범위를 bootstrap에서 거부하는 경계값 검사 |
| 배포 | Version·license·독립 설치/네트워크 출시 검증 부재 | 5개 package 0.1.0, MIT, metadata/source-map 원본 포함, isolated npm 설치, 출시 CI와 보안/배포 문서 추가 |

관련 code와 회귀 test는 `packages/nest-webtransport/src/runtime.*.spec.ts`,
`packages/driver-rwebtransport/src/*.spec.ts`, `packages/otel/src/tracing.interceptor.spec.ts`,
`tests/`에 있습니다. 변경한 native dependency의 원본 SHA-256과 재생성 절차는
`packages/driver-rwebtransport/vendor/README.ko.md` 및 `scripts/vendor-rwebtransport.mjs`에
기록했습니다.

## 검증 결과

환경: macOS arm64, Node **24.20.0 / 26.8.1**, Bun **1.3.12**, Chromium **153.0.8010.12**.

| 검증 | 결과 |
| --- | --- |
| Lint, source/test/example typecheck, build, publint | 통과 |
| 최종 unit/virtual integration | **25개 file / 112개 test 통과, skip 0** — Node 24·26 |
| 실제 native QUIC | 4개 통과 — datagram, bidi/uni 왕복, reset, authentication/Origin/path 거부, connection churn, stream flood |
| 실제 Chromium | certificate pinning, 잘못된 certificate/authentication 거부, 세 전송 channel 통과 |
| 강제 종료 | 별도 client SIGKILL → 약 30초 native idle timeout → server 생존/session 회수 — 두 Node version 통과 |
| 3분 확장 부하 시험 | **11,340회 연결 / 11,340개 stream**, 매 회차 종료 후 active session/stream 0. GC 후 heap 변화 -549,912 bytes, RSS 변화 +18,137,088 bytes |
| 이후 전체 release gate의 60초 부하 시험 | Node 24: 3,990회, heap -269,232 bytes / RSS +98,353,152 bytes. Node 26: 4,040회, heap -241,456 bytes / RSS +24,281,088 bytes. 설정한 memory 증가 상한 이내 |
| Isolated npm tarball 설치 | 5개 모두 저장소 밖에서 설치·public import·Nest bootstrap/shutdown·TypeScript 검사 통과. `skipLibCheck: false` |
| Package 내용 | Workspace reference 변환, MIT 포함, test/environment file 제외, vendored license 포함 |
| Dependency 취약점 조회 | `bun audit --json`: `{}` / 종료 code 0 |
| 변경 형식 | `git diff --check` 통과 |

확장 부하 시험은 native 종료·queue 보강 중간 단계에서 수행했고, 이후 최종 변경에는 양
version의 release gate와 최종 unit/native/browser/강제 종료/설치 재검증을 적용했습니다.
부하 시험은 매 회차 10개 동시 client와 64 KiB echo, 전송 도중 연결 종료를 사용합니다.
최대 동시 접속 용량이나 24–72시간 memory 안정성을 측정한 benchmark가 아닙니다.

## 배포물과 재실행

배포용 tarball 5개, SHA256SUMS와 ZIP bundle은 `.cache/release/0.1.0/`에 생성합니다.
`bun run release:check`로 출시 검증을 반복할 수 있습니다. OpenSSL과 Playwright Chromium
설치가 필요합니다. 자세한 순서와 npm 게시 순서는 `docs/releasing.ko.md`에 있습니다.

`rwebtransport@0.2.2`의 native binary는 원래 dependency에서 제공합니다. Package 안에
포함한 JavaScript compatibility 수정본은 **Apache-2.0**이며 별도 LICENSE/NOTICE를 동봉했습니다.
Library 자체는 사용자가 선택한 **MIT**입니다. 전역 unhandled-rejection 무시 설정은 추가하지
않았습니다.

## 확인하지 않은 범위

- 원격 GitHub Actions 실행 결과: Linux/macOS release matrix를 추가했지만 이 작업에서 push나
  원격 실행은 하지 않았습니다. Windows/Linux arm64 기존 unit/build matrix도 현지 실행하지 않았습니다.
- Network loss·jitter·NAT/MTU, 실제 Docker/Kubernetes deployment, 장시간 24–72시간 soak
- npm account 권한과 실제 게시. 조회 시 5개 이름은 공개 registry에서 모두 404였지만, 이름의
  예약 가능성이나 게시 권한을 보증하지 않습니다.

해당 platform/deployment를 지원한다고 공표하기 전에 그 환경의 CI와 운영 부하 검증 결과를
확인해야 합니다. 임의의 사용자 Promise를 강제로 취소할 수 없으므로, authentication과
handler의 외부 I/O에도 cancellation signal 및 자체 deadline을 전달해야 합니다.
