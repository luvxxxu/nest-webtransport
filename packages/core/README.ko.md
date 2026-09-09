# webtransport-core

영문 원문: [README.md](README.md)

Driver와 framework integration을 위한 런타임 중립 WebTransport 계약입니다. 이 패키지는
NestJS, Node 전용 stream type, 구체적인 QUIC 구현에 의존하지 않습니다.

Root export에는 다음이 포함됩니다.

- driver capability, startup option, statistic, session callback
- Web `ReadableStream`, `WritableStream`, `Uint8Array`, `Headers`, `AbortSignal`을 기반으로
  하는 session, 양방향 stream, 단방향 stream, datagram 계약
- handler, stream, session, server, fatal failure용 범위 지정 error
- server/session lifecycle state 및 resource-limit configuration type
- bounded queue, concurrency, fixed-window rate-limit primitive
- transport-independent codec interface 및 zero-copy raw codec

`BoundedQueue`는 설정된 capacity를 절대 넘지 않습니다. Overflow 시 명시적인 decision
(`drop-oldest`, `drop-newest`, `reject`, `close-session`)을 반환하므로 policy effect는
호출자가 소유합니다. `ConcurrencyLimiter`와 `FixedWindowRateLimiter`는 waiter queue를
만들지 않고 초과 작업을 거절합니다.

이름 있는 event와 payload framing은 의도적으로 이 계층에 속하지 않습니다. Nest integration
또는 애플리케이션 수준 routing SPI가 raw datagram을 decode하거나 stream을 route에 연결할
수 있지만, driver에 그 protocol을 강제하지는 않습니다.
