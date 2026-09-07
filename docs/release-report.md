# 0.1.0 출시 준비 검증 보고서

검증일: 2026-09-07. 대상: 현재 작업 트리의 core, Nest, native driver, testing, OTel 패키지.

## 판정

발견하고 재현한 출시 차단 결함을 수정했으며, **아래 검증 환경과 범위에서 0.1.0 공개 배포용
패키지를 준비했다.** npm 게시·Git 커밋·원격 푸시는 수행하지 않았다. 기존 작업 트리의 변경도
보존했다. 모든 환경에서 결함이 없다는 보증이나 1.0.0 프로덕션 인증을 의미하지 않는다.

## 수정한 문제

| 우선순위 | 문제와 재현 | 수정 및 회귀 검증 |
| --- | --- | --- |
| P1 | `maxSessions: 1`인데 타임아웃 후 인증 작업 4개가 남음 | 실제 인증/세션 초기화 Promise가 끝날 때까지 global/IP 슬롯 유지. 타임아웃·연결 해제 두 경로 검사 |
| P1 | 클라이언트 프로세스를 죽이면 약 30초 뒤 네이티브 타임아웃의 orphan Promise rejection 발생 | upstream `finally` 정리 코드를 성공/실패 양쪽을 처리하는 `then`으로 변경. 실제 별도 프로세스 강제 종료 후 서버 생존 확인 |
| P1 | 멈춘 핸들러 뒤로 1,000개의 완료 스트림이 계속 쌓임 | upstream-facing 스트림 큐 각 256개, 세션 큐 1,024개 상한. 초과 세션 종료와 정상 서버 유지 검사 |
| P1 | 네이티브 세션/미완료 콜백에 독립된 용량 제한이 없음 | `maxSessions`, `maxPendingSessionCallbacks` 추가. 연결이 닫혀도 남은 콜백 제한 검사 |
| P1 | 드라이버의 실제 native close가 멈추면 종료 시간이 제한되지 않음 | 전체 종료 대기에 deadline/abort 적용. 실패 시 `STOPPING` 유지 및 종료가 완료된 뒤 재시도 검사 |
| P2 | 쓰기 작업이 없는 스트림에서 peer 오류를 놓치고 잠금을 유지 | native reader/writer 종료 관찰, 부모 세션 abort 전파, idempotent reset/stop. 양방향 reset 오류 보존 |
| P2 | 데이터그램의 idle 오류 및 close가 wrapper에 즉시 반영되지 않음 | native 종료 관찰, wrapper 오류 전파, 버퍼 폐기와 reader/writer 잠금 해제 검사 |
| P2 | 네이티브 서버가 예상 없이 끝나도 RUNNING/정상 liveness로 보일 수 있음 | native closed 감시 및 드라이버 실패 시 health 반영 |
| P2 | 상속한 gateway 메서드의 매개변수 decorator를 잃음 | 메서드를 실제 선언한 prototype에서 metadata 조회. 상속과 세션별 DI 검사 |
| P1 | OTel 경로 속성에 URL query의 인증 ticket이 포함됨 | query/fragment 제거 및 속성에 secret이 없는지 검사 |
| P2 | OTel span context 밖에서 실제 Observable 구독 실행 | span context 안에서 subscribe. 핸들러 실행 시 context 확인 |
| P2 | Node 범위를 넘는 timeout이 1ms로 바뀔 수 있고 큐 크기가 런타임에서 실패 | timer/queue 범위를 bootstrap에서 거부하는 경계값 검사 |
| 배포 | 버전·라이선스·독립 설치/네트워크 출시 검증 부재 | 5개 패키지 0.1.0, MIT, metadata/source-map 원본 포함, isolated npm 설치, 출시 CI와 보안/배포 문서 추가 |

관련 코드와 회귀 테스트는 `packages/nest-webtransport/src/runtime.*.spec.ts`,
`packages/driver-rwebtransport/src/*.spec.ts`, `packages/otel/src/tracing.interceptor.spec.ts`,
`tests/`에 있다. 변경한 네이티브 의존성의 원본 SHA-256과 재생성 절차는
`packages/driver-rwebtransport/vendor/README.md` 및 `scripts/vendor-rwebtransport.mjs`에 기록했다.

## 검증 결과

환경: macOS arm64, Node **24.20.0 / 26.8.1**, Bun **1.3.12**, Chromium **153.0.8010.12**.

| 검증 | 결과 |
| --- | --- |
| 린트, 소스/테스트/예제 타입 검사, 빌드, publint | 통과 |
| 최종 unit/virtual integration | **25개 파일 / 112개 테스트 통과, 건너뜀 0** — Node 24·26 |
| 실제 native QUIC | 4개 통과 — 데이터그램, bidi/uni 왕복, reset, 인증/Origin/경로 거부, 연결 churn, stream flood |
| 실제 Chromium | certificate pinning, 잘못된 인증서/인증 거부, 세 전송 채널 통과 |
| 강제 종료 | 별도 클라이언트 SIGKILL → 약 30초 native idle timeout → 서버 생존/세션 회수 — 두 Node 버전 통과 |
| 3분 확장 부하 시험 | **11,340회 연결 / 11,340개 스트림**, 매 회차 종료 후 활성 세션/스트림 0. GC 후 heap 변화 -549,912 bytes, RSS 변화 +18,137,088 bytes |
| 이후 전체 release gate의 60초 부하 시험 | Node 24: 3,990회, heap -269,232 bytes / RSS +98,353,152 bytes. Node 26: 4,040회, heap -241,456 bytes / RSS +24,281,088 bytes. 설정한 메모리 증가 상한 이내 |
| isolated npm tarball 설치 | 5개 모두 저장소 밖에서 설치·public import·Nest bootstrap/shutdown·TypeScript 검사 통과. `skipLibCheck: false` |
| 패키지 내용 | workspace 참조 변환, MIT 포함, 테스트/환경 파일 제외, vendored 라이선스 포함 |
| 의존성 취약점 조회 | `bun audit --json`: `{}` / 종료 코드 0 |
| 변경 형식 | `git diff --check` 통과 |

확장 부하 시험은 네이티브 종료·큐 보강 중간 단계에서 수행했고, 이후 최종 변경에는 양 버전의
출시 gate와 최종 unit/native/browser/강제 종료/설치 재검증을 적용했다. 부하 시험은 매 회차
10개 동시 클라이언트와 64 KiB echo, 전송 도중 연결 종료를 사용한다. 최대 동시 접속 용량이나
24–72시간 메모리 안정성을 측정한 벤치마크가 아니다.

## 배포물과 재실행

배포용 tarball 5개, SHA256SUMS와 ZIP 묶음은 `.cache/release/0.1.0/`에 생성한다.
`bun run release:check`로 출시 검증을 반복할 수 있다. OpenSSL과 Playwright Chromium 설치가
필요하다. 자세한 순서와 npm 게시 순서는 `docs/releasing.md`에 있다.

`rwebtransport@0.2.2`의 네이티브 바이너리는 원래 의존성에서 제공한다. 패키지 안에 포함한
JavaScript 호환성 수정본은 **Apache-2.0**이며 별도 LICENSE/NOTICE를 동봉했다. 라이브러리
자체는 사용자가 선택한 **MIT**다. 전역 unhandled-rejection 무시 설정은 추가하지 않았다.

## 확인하지 않은 범위

- 원격 GitHub Actions 실행 결과: Linux/macOS 출시 matrix를 추가했지만 이 작업에서 push나
  원격 실행은 하지 않았다. Windows/Linux arm64 기존 unit/build matrix도 현지 실행하지 않았다.
- 네트워크 손실·지터·NAT/MTU, 실제 Docker/Kubernetes 배포, 장시간 24–72시간 soak.
- npm 계정 권한과 실제 게시. 조회 시 5개 이름은 공개 registry에서 모두 404였지만, 이름의
  예약 가능성이나 게시 권한을 보증하지 않는다.

해당 플랫폼/배포를 지원한다고 공표하기 전에 그 환경의 CI와 운영 부하 검증 결과를 확인해야
한다. 임의의 사용자 Promise를 강제로 취소할 수 없으므로, 인증과 핸들러의 외부 I/O에도
취소 신호 및 자체 deadline을 전달해야 한다.
