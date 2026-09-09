# 기본 네이티브 예제

영문 원문: [README.md](README.md)

이 예제는 Nest application context를 부트하고 native `rwebtransport` driver를 통해
`/basic`에서 WebTransport를 제공합니다. 원시 형태의 이름 없는 handler를 사용합니다.

- datagram을 client에 echo합니다.
- 양방향 stream byte를 client로 pipe합니다.
- 단방향 stream을 소비하고 최종 byte 수를 log합니다.

Gateway는 `@Payload()`와 `@Stream()`으로 incoming value를 받습니다. Nest runtime과
session-level collection reader를 두고 경쟁하지 않습니다.

## 설정

Node.js 24.x 또는 26.x를 사용하세요. Bun은 dependency를 설치하고 저장소 script를
실행하며, `start` script 자체는 application을 Node로 실행합니다.

`.env.example`을 `.env`로 복사하고 모든 placeholder를 바꾸세요.

```dotenv
WEBTRANSPORT_HOST=0.0.0.0
WEBTRANSPORT_PORT=4433
WEBTRANSPORT_TLS_CERT_PATH=/absolute/path/to/webtransport.crt
WEBTRANSPORT_TLS_KEY_PATH=/absolute/path/to/webtransport.key
WEBTRANSPORT_ALLOWED_ORIGINS=https://app.example.com
WEBTRANSPORT_AUTH_TOKEN=replace-with-a-random-token-of-at-least-32-characters
```

`WEBTRANSPORT_ALLOWED_ORIGINS`는 canonical하고 정확한 HTTP(S) origin을 쉼표로 구분한
목록으로 받습니다. Wildcard, path, query string, fragment, credential, trailing slash는
거절됩니다. 같은 목록을 두 번 적용합니다. `rwebtransport`가 정적 pre-CONNECT 검사에
사용하고, Nest runtime이 portable post-surface 검사에 사용합니다.

Bearer token 검사는 native driver가 established session을 노출한 직후 실행됩니다.
`rwebtransport` 0.2.2에는 동적 pre-CONNECT authentication hook이 없으므로, token 검사가
실패하면 HTTP/3 CONNECT 요청을 거절하는 대신 해당 session을 닫습니다.

## 실행

저장소 최상위 폴더에서 실행하세요.

```bash
bun install
bun run --cwd examples/basic typecheck
bun run --cwd examples/basic start
```

Client는 정확히 허용된 Origin과 `Authorization: Bearer <WEBTRANSPORT_AUTH_TOKEN>` header를
사용해 `https://<host>:<port>/basic`에 연결해야 합니다. 이 간결한 예제에는 browser client,
certificate 생성, HTTP health endpoint, deployment manifest가 포함되지 않습니다.
