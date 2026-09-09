# 변경 로그

영문 원문: [CHANGELOG.md](CHANGELOG.md)

## 1.0.0-rc.1

- 요청 범위 Nest global enhancer, module 소유 provider resolution, fail-open enhancer fallback을 수정했습니다.
- aggregate server work, active incoming stream, retained datagram byte, log volume에 상한을 적용했습니다.
- 실제 작업이 정리될 때까지 reservation을 유지하고, 늦게 완료된 resolver/enhancer가 닫힌 session을 호출하지 못하게 했습니다.
- 수동 I/O activity refresh, runtime policy metric, private error diagnostic을 추가하고 driver liveness 불일치를 수정했습니다.
- incoming collection 취소 중 active stream을 유지하고, native write/close 실패를 전파합니다.
- connection stats sampling에 상한을 적용하고 virtual transport direction/abort 동작을 수정했습니다.
- 제한된 Redis failure handling, JWT session expiry, race-safe presence cleanup을 적용해 production example을 boot할 수 있게 했습니다.
- container build input을 수정하고 실제 bootstrap, deployment, release 검사를 강화했습니다.
- OTel exception detail을 기본적으로 비식별화하고, driver metric과 별도로 제한 초과·폐기 원인의 runtime metric을 노출합니다.
- 기본 session ceiling을 1,000으로 낮췄습니다. v1 이전 migration과 qualification gate는 [releasing.ko.md](docs/releasing.ko.md)를 참고하세요.

## 0.1.0

Core, NestJS integration, rwebtransport driver, testing utility, 선택적 OpenTelemetry
integration의 최초 release입니다.

- 선택적 application routing을 지원하는 raw datagram, 양방향·단방향 stream handler
- Nest discovery, inherited handler, session-scoped dependency injection, guard, pipe,
  interceptor, exception filter
- Origin/authentication admission, 제한된 work queue, connection/stream/rate limit,
  timeout, graceful drain, readiness reporting
- Timeout 또는 disconnect 후에도 정리될 때까지 authentication work를 capacity에 포함
- Native stream termination을 consumer에게 전파하고 reader/writer lock 해제
- Native callback/session capacity 및 timeout 후 retry하는 제한된 shutdown
- 비정상 session close 시 process 종료를 수정하고, Nest가 소비하기 전에 incoming session/stream
  queue에 상한을 적용한 고정 upstream compatibility bundle
- 예기치 않은 native server termination 시 driver readiness 초기화
- Span context 안에서 tracing을 구독하고 URL query/fragment credential을 제외
- 표준 설치 명령에서 framework package 하나만 필요하도록 `nest-webtransport`가 native driver를 재-export
- MIT license, 대응 source가 포함된 source map, 격리된 package installation 검사
- 자동화된 native, Chromium, overload, abrupt-disconnect, sustained-load release gate
