# 릴리스

영문 원문: [releasing.md](releasing.md)

5개 패키지는 `1.0.0-rc.1`로 함께 버전 관리됩니다. 이는 v1 후보이므로 [v1 준비도](v1-readiness.ko.md)에
있는 대상 환경 gate가 남김없이 통과한 뒤에만 `1.0.0`으로 승격하세요. 후보 버전은 aggregate
limit을 추가하고 보수적인 기본값을 변경하므로 아래 migration note를 검토해야 합니다.
이 저장소는 artifact를 준비하지만 자동으로 게시하지 않습니다.

## 필수 검사

Node.js 24.x 또는 26.x, Bun 1.3.12, OpenSSL을 사용하세요. 다른 Node major 버전은 native
package에서 지원하지 않습니다. Nest package도 같은 Node matrix를 따르며 standalone
core/testing package에는 Node 20.11 이상이 필요합니다.

```sh
bun ci
bunx playwright install --with-deps chromium
bun run release:check
bun audit
```

`release:check`는 lint, source/test/example typecheck, unit 및 virtual integration test,
package validation, 실제 native QUIC integration, Chromium integration, 지속 부하, workspace
밖에서 5개 tarball을 깨끗한 npm 환경에 설치하는 검사를 수행합니다. Installation verification은
public import, Nest bootstrap/shutdown, `skipLibCheck` 없는 TypeScript declaration, license,
변환된 workspace dependency version을 확인합니다. npm publication은 하지 않습니다.

Native test는 SHA-256으로 pinning한 새 단기 ECDSA certificate를 사용합니다. TLS verification을
끄지 않습니다. Test listener는 loopback에만 bind하고 사용하지 않는 port를 선택합니다.

Abrupt-disconnect gate는 별도 native client process를 종료하고 실제 30초 QUIC idle timeout을
기다린 뒤 server가 생존하며 session을 회수하는지 단언합니다.

Soak gate의 기본값은 60초이며, 매 round에 동시 client 10개, 64 KiB stream echo, active
stream 중 disconnect를 사용합니다. 각 round에서 session과 stream이 0으로 돌아오는지 확인합니다.
Warmup 이후 보유 JS heap 증가는 20 MiB 미만, RSS 증가는 128 MiB 미만이어야 합니다. 배포
적합성 검증에는 더 긴 실행을 사용하세요.

```sh
WEBTRANSPORT_SOAK_MS=1800000 bun run test:soak
```

이 검사에 통과하면 제한된 시나리오를 검증한 것이며, 모든 workload·network·deployment를
검증한 것은 아닙니다. 애플리케이션에 맞춰 admission, stream, handler, infrastructure
limit을 산정하세요. 프로덕션에서 테스트되었다고 알리기 전에 각 대상 OS/architecture에서
release workflow를 검증하세요.

## 게시

1. Release report, changelog, MIT license, security documentation을 검토합니다.
2. 패키지 이름이 의도한 npm 계정에 속하고, 게시할 정확한 commit에 해당하는 release
   workflow가 성공했는지 확인합니다.
3. Bun으로 pack(`workspace:*`를 해석함)하고 5개 tarball을 검사합니다.
4. 다음 dependency 순서로 tarball을 게시합니다: `webtransport-core`,
   `webtransport-driver-rwebtransport`, `nest-webtransport`,
   `nest-webtransport-testing`, `nest-webtransport-otel`.
5. 공개된 version을 깨끗한 application에 설치하고 smoke check를 다시 실행합니다.

Registry publication을 확인하는 동안에는 release candidate dist-tag를 사용하세요. Registry
소유권, credential, 성공적인 publication은 local artifact validation과 별개의 문제입니다.

## 0.1.0에서 이관

- 기본 runtime/native session ceiling이 1,000으로 줄었습니다. 더 큰 workload에는 검증된
  ceiling을 명시적으로 설정하세요. `limits.server`에는 이제 `maxConcurrentHandlers`,
  `maxPendingHandlers`, `maxStreams`, `maxQueuedDatagramBytes`가 포함됩니다. 완전히 구성된
  core `WebTransportServerLimits` object에는 이 field가 필요하며 module override는 여전히
  partial입니다.
- Global execution capacity에는 admission과 연결이 끊겼지만 완료되지 않은 작업이 포함됩니다.
  Budget을 소진하면 admission은 거절되고 event에는 설정된 handler overflow policy가 적용됩니다.
- `getRuntimeStats()`와 `webtransport.runtime.*` metric은 policy drop/rejection과 driver
  counter를 구분합니다. 둘 모두에 alert를 설정하세요. Log에는 기본 rate limit이 적용됩니다.
- 수동/outgoing I/O에는 `SessionContext.touch()`를 사용하거나 `idleTimeoutMs: 0`으로 자체
  idle cleanup을 관리하세요.
- Native write/close 실패는 이제 성공을 보고하지 않고 reject됩니다. Transport failure를 처리하세요.
- OTel exception detail은 기본적으로 비식별화됩니다. Raw detail은 exporter redaction을
  적용할 때만 활성화하세요.
- 프로덕션 JWT session은 token과 함께 만료됩니다. Redis offline buffering은 비활성화되며
  멈춘 command 또는 소진된 reconnect는 liveness를 실패시킵니다. Orchestrator restart
  policy를 설정하세요.
- Request-scoped Nest global은 실제 provider token과 소유 module을 유지합니다. 등록된
  provider failure는 전파되며 새로 설정되지 않은 enhancer로 fallback하지 않습니다.

안정적인 SemVer를 약속하기 전에 소비자 application을 후보 버전에 맞춰 검토하세요.
