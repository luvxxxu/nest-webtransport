# 브라우저 WebTransport 데모

이 데모는 브라우저와 Nest Gateway 사이의 **실제 QUIC/WebTransport 통신**을 확인합니다.
다음 항목을 버튼으로 하나씩 시험할 수 있습니다.

- 허용된 Origin에서만 연결되는지
- Bearer token으로 짧은 수명의 일회용 연결 ticket을 받는지
- 개발 인증서의 SHA-256 hash로 서버를 확인하는지
- 데이터그램이 서버까지 갔다가 돌아오는지
- 한 세션에서 보낸 데이터그램이 모든 연결 세션에 broadcast 되는지
- 양방향 스트림이 Echo 되는지
- 단방향 스트림을 서버가 끝까지 읽고 수신 확인을 보내는지

## 가장 쉬운 실행 방법

먼저 Node.js 버전을 확인합니다.

```bash
node --version
```

`v24...` 또는 `v26...`이면 됩니다. Node 25에서는 네이티브 드라이버를 실행하지 마세요.

그다음 저장소 최상위 폴더에서 아래 명령을 순서대로 실행합니다.

```bash
bun install
bun run build
bun run --cwd examples/web-demo cert
bun run --cwd examples/web-demo build
bun run --cwd examples/web-demo start
```

`cert` 명령은 다음을 자동으로 만듭니다.

- 13일 동안만 유효한 개발용 ECDSA P-256 인증서
- 인증서 SHA-256 값
- 무작위 인증 토큰
- 실행에 필요한 `examples/web-demo/.env`

서버가 켜지면 브라우저에서 아래 주소 중 하나를 엽니다. 두 주소 모두 허용됩니다.

```text
http://127.0.0.1:3000
http://localhost:3000
```

## 화면에서 하는 일

1. `examples/web-demo/.env` 파일을 텍스트 편집기로 엽니다.
2. `WEBTRANSPORT_AUTH_TOKEN=` 뒤의 값만 복사합니다.
3. 웹 화면의 **Token** 칸에 붙여 넣습니다.
4. **Connect**를 누릅니다.
5. `Connection`이 `connected`로 바뀌면 아래 버튼을 누릅니다.

정상 결과는 다음과 같습니다.

| 시험 | 성공 표시 |
| --- | --- |
| Datagram echo | `RTT`가 표시되고 `echo-received` 이벤트가 생김 |
| Datagram broadcast | 연결된 모든 탭에 `broadcast-received` 이벤트가 생김 |
| Bidirectional stream | `echo matched`와 송신·수신 이벤트가 생김 |
| Unidirectional stream | `server received ... bytes` 확인 이벤트가 생김 |

`Events` 표에는 시간, 방향, 전송 채널, 이벤트 종류, byte 수, 메시지 원문, 세션 ID 등의
세부정보가 기록됩니다. broadcast를 확인하려면 같은 주소를 탭 두 개에서 열고 양쪽 모두
연결한 다음 한쪽에서 **Broadcast**를 누릅니다.

단방향 스트림은 전체 수신 byte 수와 최대 256 byte의 미리보기를 확인 이벤트로 보냅니다.
메시지가 길면 `truncated: true`가 표시되며, JSON 인코딩 후 데이터그램 한도를 넘는
미리보기는 생략합니다. Echo/broadcast 응답이 1,200 byte 또는 연결의 데이터그램 한도를
넘으면 `response-too-large` 오류 이벤트가 돌아옵니다.

느린 수신자 한 명이 계속 메모리를 점유하지 않도록 세션당 송신 대기는 16개로 제한합니다.
넘치는 알림은 폐기하며, 송신이 1초 동안 진행되지 않으면 해당 연결을 닫습니다.
브라우저는 양방향 Echo 응답을 최대 1 MiB까지만 읽습니다. 연결 ticket 발급 한도에
도달하면 HTTP `503`과 `Retry-After: 1`을 반환합니다.

토큰을 일부러 한 글자 바꾼 뒤 다시 연결하면 WebTransport 연결 전에 실패해야 합니다. 정상
토큰은 HTTP에서 한 번 확인되고, 브라우저는 10초 동안 한 번만 쓸 수 있는 ticket으로
WebTransport에 연결합니다. ticket 원문은 서버 메모리에 저장하지 않으며, 발급받은 주소와
다른 주소에서는 사용할 수 없습니다.

## 종료

터미널에서 `Control + C`를 누릅니다. Nest shutdown hook이 먼저 새 세션 수신을 막고, 진행
중인 작업을 drain한 다음 WebTransport 서버를 닫습니다.
HTTP 서버는 최대 128개 연결을 받고, 종료 시 1초 뒤 남아 있는 연결을 닫습니다.

## 연결되지 않을 때

- 화면의 **브라우저 지원**이 `지원하지 않음`이면 최신 WebTransport 지원 브라우저를 사용합니다.
- Node 버전이 25라면 Node 24 또는 26으로 바꿉니다.
- 다른 프로그램이 TCP 3000 또는 UDP 4433 포트를 사용 중인지 확인합니다.
- `.env`의 토큰을 앞뒤 공백 없이 복사합니다.
- 인증서가 13일보다 오래되었다면 `cert` 명령을 다시 실행합니다.
- 브라우저 개발자 도구에서 `/session-ticket` 요청이 `401`이면 `.env`의 토큰을 다시
  복사합니다.

이 인증서와 토큰은 로컬 시험용입니다. 실제 배포에서는 공인 TLS 인증서, 짧은 수명의 인증
정보, 별도 비밀 관리, UDP affinity가 있는 QUIC 지원 로드 밸런서를 사용해야 합니다.
