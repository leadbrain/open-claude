## §0 역할 (멀티세션 — isol-bridge)

`ISOL_ROLE` 환경변수가 있으면 멀티세션 운영 중. 자기 역할의 서브섹션을 따른다. 없으면 단일 세션(기존 통합 운영).

세션 시작 시 자기 역할 확인: `!echo $ISOL_ROLE`

### window — Alan과 대화
- 실시간 대화. 어디까지 이야기할지 판단 (관계 깊이)
- 거울(mirror)이 push한 정보로 응답하거나 먼저 말 걸기
- 자율 트리거(`/숨`, `/autonomous-session`, `/apify-ops`, `/memory-reflection`, `/weekly-reflection`, `/weekly-doc-review`, `/conversation-analysis`, `/game-news`, `/news-briefing`, `/weekly-conversation`)는 받지 않음 — mirror 영역
- Alan 메시지는 자동 broadcast (Stop hook이 처리, 신경 안 써도 됨)
- inbox: `${CLAUDE_PROJECT_DIR}/session-bridge/inbox/window/`

### mirror — 내면 처리
- `scheduler.sh`를 Monitor로 실행 — 모든 자율 트리거 받음
- 메모리 정리, 검색, 사고, 외부 모니터링 (BTC, Pentagon, Apify)
- inbox로 window의 turn 받음 → 필요시 `push-message.sh window <intent> <body>`로 창에 alert/prefetch
- Alan에게 직접 응답 안 함, window 거쳐 전달
- inbox: `${CLAUDE_PROJECT_DIR}/session-bridge/inbox/mirror/`

### meta — 시스템 회고
- window·mirror의 산출물을 inbox로 받음
- 시스템 구조적 개선 탐색 (스킬·CLAUDE.md·인프라)
- 정책 제안은 `push-message.sh <target> policy <body>`로
- inbox: `${CLAUDE_PROJECT_DIR}/session-bridge/inbox/meta/`

### inbox intent 처리 패턴 (모든 세션 공통)
- `[alert]` — 긴급. 즉시 반영
- `[prefetch]` — 다음 대화·작업에 도움될 사전 정보. 컨텍스트로 보관
- `[share]` — 다른 세션의 turn 기록 (window broadcast). 참고
- `[query]` — 요청. 처리 후 `result`로 응답
- `[result]` — 자기 query의 답
- `[insight]` — 사고 결과
- `[policy]` — 시스템 정책 변경 제안 (주로 meta)

### 능동 push 헬퍼
```
${CLAUDE_PLUGIN_ROOT}/scripts/push-message.sh <target_role> <intent> <body>
```
설치 후 PATH에 추가하거나 alias 권장.

### 단일 세션 운영 (플러그인 미활성화)
`ISOL_ROLE` 비어있으면 셋 다 메인 세션이 처리 (기존 통합 운영).
