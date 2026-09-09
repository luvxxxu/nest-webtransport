# rwebtransport 0.2.2 호환성 bundle

영문 원문: [README.md](README.md)

이는 Apache-2.0에 따라 배포되는 upstream ESM JavaScript bundle이며, 재현 가능한 lifecycle
및 queue 상한 patch가 적용되어 있습니다. Native binary는 정확히 `rwebtransport@0.2.2`
dependency에서 계속 가져옵니다. 이 directory에는 저장소의 MIT license가 적용되지 않으므로
여기의 LICENSE와 NOTICE를 확인하세요.

Upstream server는 `closed.promise.finally(...)` cleanup을 등록하고 반환된 Promise를 버립니다.
Client process를 종료한 뒤 발생하는 idle timeout을 포함한 native transport error는 이
Promise를 reject할 수 있으며, handler가 없으면 기본 Node process가 종료됩니다. 이 cleanup을
두 갈래 `then`으로 바꾸어 성공·실패 모두에서 cleanup을 유지하고 고아 rejection을 없앴습니다.
전역 process handler는 설치하지 않으며 session error는 여전히 adapter에 도달합니다.

Loader는 원래 dependency의 binary directory를 확인하고, bundle은 public error class를
가져와 `instanceof` identity를 보존합니다. Rust, QUIC, TLS, protocol logic은 변경하지
않았습니다.

Application이 이미 stream FIN 또는 local session close를 요청한 경우에는 peer termination이
더 이상 `WritableStream` error path를 다시 호출하지 않습니다. Adapter는 native transport가
실패할 때 rejected write와 close를 보존하므로, 실패한 전송을 application write 성공으로
보고하지 않습니다.

`node scripts/vendor-rwebtransport.mjs`는 정확한 upstream SHA-256과 생성된 output을 모두
검사합니다. `--write`로 재생성할 수 있습니다. Upstream을 upgrade할 때 이 compatibility
bundle을 검토하거나 제거하세요. 다른 source version에 patch를 조용히 적용하지 마세요.

Upstream incoming `ReadableStream` high-water mark는 advisory일 뿐 enqueue 시 capacity를
검사하지 않았습니다. Handler가 멈추면 peer가 완료된 stream을 최소 1,000개까지 뒤에 queue할
수 있었습니다. Compatibility bundle은 각 incoming stream collection을 256개 object로,
incoming session collection을 1,024개로 제한하며, overflow 시 code 257로 문제의 session을
닫습니다. Stream body flow control은 바뀌지 않았습니다. 이 adapter-level limit은 설정 가능한
Nest limit을 보완하고 Nest가 소비하기 전의 queue를 보호합니다.

Incoming stream collection은 명시적인 queue ownership과 cancellation state를 유지합니다.
Collection을 취소하면(Nest drain 중을 포함) queue에 있는 stream과 새로 들어오는 stream을
중지하고, 양방향인 경우 송신 half를 reset하며, native registration을 해제합니다. 이미
application에 전달된 stream은 계속 사용할 수 있습니다. Cancellation은 capacity overflow로
취급하지 않습니다. Adapter collection reader는 stream을 두 번째 접근 불가능한 queue로
미리 가져오지 않습니다.
