# 프로덕션 예제

영문 원문: [README.md](README.md)

이 예제는 deployment 경계를 숨기지 않고 프레임워크의 프로덕션용 구성 요소를 함께 보여줍니다.

- native-driver와 Nest admission layer 양쪽의 정확한 Origin 검사
- handler, datagram, session, stream, rate limit
- issuer, audience, expiry, not-before 검사를 포함한 HS256 JWT authentication
- 만료가 있는 Redis 기반 session presence
- OpenTelemetry driver instrument와 handler span
- 별도 TCP port의 `/livez`, `/readyz`, Prometheus text `/metrics` endpoint
- drain 우선 shutdown 및 Kubernetes probe/resource

`.env.example`을 `.env`로 복사하고 모든 credential과 endpoint를 바꾼 뒤 실행하세요.

```bash
bun install
bun run build
bun run --cwd examples/production build
node --env-file=examples/production/.env examples/production/dist/main.js
```

WebTransport listener는 기본적으로 UDP/4433입니다. Operations listener는 TCP/3000입니다.
프로덕션 QUIC 지원 load balancer는 연결 수명 동안 UDP affinity를 유지해야 합니다. Redis는
살아 있는 QUIC session을 replica 사이에서 이동시키지 않습니다.

OpenTelemetry package는 `@opentelemetry/api`를 통해 내보냅니다. `AppModule`을 import하기
전에 환경에 필요한 SDK와 exporter를 설치하고 초기화하세요. `/metrics` endpoint는 driver와
runtime counter/gauge의 dependency-free Prometheus snapshot입니다.

Kubernetes file에는 placeholder image, origin, TLS Secret, application Secret name이 있습니다.
Cluster에 해당 resource가 실제로 존재한다는 의미가 아니라 수정해 사용할 예제입니다.

`AppModule.register(loadProductionConfig())`는 bootstrap 시 application configuration을
생성합니다. Test suite는 virtual transport와 mock Redis dependency로 실제 Nest module을
부트한 뒤 authenticated traffic, presence cleanup, HTTP probe, runtime metric을 검사합니다.

JWT는 `Authorization: Bearer` header로 받고 설정된 issuer와 audience를 사용한 HS256이어야
합니다. 무작위 secret(`openssl rand -hex 32`)을 생성하세요. 비어 있거나 알려진 placeholder
secret은 startup에서 실패합니다. Active session은 JWT가 만료되면 닫히므로 client는 새 token을
받아 reconnect해야 합니다. 즉시 token revocation과 account logout에는 application별
revocation mechanism이 필요합니다. Browser는 임의의 WebTransport Authorization header를
설정할 수 없으므로 browser client를 추가할 때 `examples/web-demo`의 단기 일회용 ticket
exchange를 사용하세요. 재사용 가능한 JWT를 URL에 넣지 마세요.

Client는 30초마다 byte `1`로 시작하는 datagram을 보내 presence를 갱신합니다. Key는 마지막
update 뒤 120초 후 만료됩니다. 진행 중인 SET 중 disconnect가 발생하면 해당 write 후 cleanup을
예약하며, cleanup은 idempotent이고 Redis TTL은 Redis를 사용할 수 없을 때 fallback입니다.
Redis presence는 권고용 정보이지 영속적인 online-user registry가 아닙니다.

Redis는 `REDIS_URL`로 명시적으로 설정해야 합니다. Offline queue는 비활성화되고 command queue는
256개로 제한되며, socket connection attempt timeout은 1초이고 reconnect는 최대 5회 bounded
backoff를 사용합니다. Startup 전체 예산은 5초이며, 개별 command와 shutdown drain에는 각각
1초 예산이 있습니다. Session cancellation은 caller를 즉시 해제합니다. 멈춘 command는 Redis
connection을 destroy하여 보유 작업에 상한을 둡니다. Retry가 소진되거나 command deadline을
넘으면 `/livez`가 실패하여 process supervisor가 instance를 재시작할 수 있으며, 일시적인
reconnect 중에는 `/readyz`만 실패합니다. Redis traffic이 신뢰할 수 없는 network를 통과하면
`rediss://`를 사용하세요. 이 정책은 [node-redis production guidance](https://redis.io/docs/latest/develop/clients/nodejs/produsage/)
와 [client configuration](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md)를
따르며, 고정된 node-redis version을 대상으로 동작을 회귀 테스트했습니다.

예제는 server를 1,000 session, active incoming stream 512개, 동시 handler 128개, 대기
handler 512개, 대기 datagram payload 8 MiB로 제한합니다. 각 session은 동시 handler 8개,
대기 handler 16개, 대기 datagram 16개까지입니다. 이는 시작점이며 검증된 capacity 보장이
아닙니다. 상한을 올리기 전에 handler를 사용해 CPU, memory, latency, loss를 측정하세요.
Runtime rejection/drop counter와 queue gauge는 driver counter와 별도로 내보냅니다.
JSON transport logging은 stdout이 backpressure 상태일 때 새 record를 폐기하고, 다음 record가
억제된 수를 보고하므로 제한 없는 log queue가 커지지 않습니다.

Operations listener의 기본값은 loopback입니다. 비공개로 유지하세요. Kubernetes 예제는
probe를 위해 `0.0.0.0`을 선택하고 별도 ClusterIP service를 통해 operations를 노출합니다.
Monitoring workload로 metric을 제한하도록 cluster network policy를 조정하세요. Pod는 root나
추가 capability 없이 실행하고 TLS를 read-only로 mount하며, 5초 pre-stop delay와 transport
drain·cleanup을 위해 40초를 예약합니다.

저장소 최상위 폴더에서 image를 빌드하세요.

```bash
docker build --file examples/production/Dockerfile --tag nest-webtransport-production:local .
```

Image는 build와 run 모두 Node 26을 사용합니다. Bun은 dependency를 설치하고 build script를
실행하며, runtime에는 production dependency만 있습니다. Docker build context는 local
environment file, TLS key/certificate, cache, host-generated dependency를 제외합니다. CI는
깨끗한 checkout에서 image를 빌드하고 runtime import를 검사합니다. 실제 Redis outage/recovery,
Kubernetes rolling update, UDP load balancer, certificate rotation, 장시간 load test는 대상
deployment environment에서 별도로 실행해야 합니다.
