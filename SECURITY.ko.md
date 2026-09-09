# 보안 정책

영문 원문: [SECURITY.md](SECURITY.md)

보안 수정은 최신 릴리스 버전을 대상으로 합니다. 서버를 노출하기 전에 admission timing,
resource limit, cancellation, deployment 경계를 설명하는 [보안 모델](docs/security.ko.md)을
읽으세요.

의심되는 취약점은 가능한 경우 이 저장소의 GitHub private vulnerability reporting을 통해
비공개로 신고하세요. 그렇지 않으면 GitHub profile의 contact channel을 통해 maintainer와
비공개 공개 절차를 조율하세요. 공개 issue에 credential, 악용 가능한 세부 정보, 사용자
데이터를 올리지 마세요.

영향받는 package/version, runtime/platform, 최소 재현 방법, 예상·관찰 동작, 영향 범위를
포함하세요. 재현에는 local test environment를 사용하세요. 공개가 허용하는 경우 confirmed
fix의 release에는 regression test와 changelog entry가 포함됩니다.
