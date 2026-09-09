# webtransport-driver-rwebtransport

영문 원문: [README.md](README.md)

`rwebtransport`를 기반으로 하는 native QUIC 및 HTTP/3 adapter입니다. 지원 runtime은
upstream Node.js 24.x 및 26.x binary matrix를 따릅니다.

Bun으로 설치할 때 저장소는 upstream `rwebtransport` postinstall hook을 명시적으로 신뢰합니다.
Bun security policy가 해당 hook을 차단하는 consumer는 hook을 검토한 뒤 native driver를
사용하기 전에 `bun pm trust rwebtransport`를 실행해야 합니다.

## 호환성 강화

이 package는 `rwebtransport`를 0.2.2로 고정하고, 비정상 session cleanup과 제한 없는
incoming object queue를 수정한 Apache-2.0 JavaScript bundle을 포함합니다. Native binary는
여전히 원래 dependency에서 옵니다. `vendor/README.md`, `vendor/LICENSE`,
`vendor/NOTICE`를 참고하세요.

`RWebTransportDriver`는 `maxSessions`(기본 1,000)와 `maxPendingSessionCallbacks`(기본
1,024)를 받습니다. Upstream-facing queue도 pending incoming session을 1,024개로, 방향·
session별 pending stream을 256개로 제한합니다. Queue overflow는 문제를 일으킨 session을
닫습니다. 이 limit은 native handshake 뒤에 적용되며 pre-CONNECT admission firewall이 아닙니다.

`port` getter는 `start()` 뒤 bind된 UDP port를 보고하며, `port: 0`으로 설정한 경우도
포함합니다. `stop({timeoutMs})`는 shutdown에 상한을 두고, 실패 시 성공적으로 retry할 때까지
`STOPPING` 상태를 유지합니다.

`getStats()`는 counter를 즉시 반환하고 connection detail의 cache를 비동기로 갱신합니다.
Native connection snapshot은 호출자 사이에서 공유되며 `connectionStatsIntervalMs`(기본
1,000 ms)마다 최대 한 번 갱신되고, 동시에 최대 32개의 request가 실행됩니다. Refresh가
끝날 때까지 첫 snapshot에는 connection detail이 없을 수 있습니다. 닫힌 session은 즉시
사라집니다. 따라서 health check나 metric scrape마다 native request를 모든 connection에
보내지 않습니다.

`onError(error)`는 비동기 native server failure를 private diagnostic sink로 선택적으로
받습니다. 이 callback의 exception과 rejected promise는 shutdown과 격리됩니다. 비식별화되지
않은 native error를 public client나 metric label에 노출하지 마세요.
