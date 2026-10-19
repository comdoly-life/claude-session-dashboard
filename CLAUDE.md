# claude-session-dashboard

Claude Code 함수 훅 mod `session-dashboard`의 저장소입니다. 이 폴더가 mod 자체이면서, 이 컴퓨터에서는
로컬 마켓플레이스(`claude-session-dashboard`)로 설치되어 있어 여기서 고친 내용이 바로 쓰입니다.
공개 저장소: https://github.com/comdoly-life/claude-session-dashboard (안내 페이지는 `docs/`, GitHub Pages)

화면과 문서는 한국어로 씁니다.

## 구조

- `.claude-plugin/plugin.json` — mod 이름·버전·설명. `marketplace.json` — 이 저장소를 마켓플레이스로 만든다(`source: "./"`).
- `hooks/hooks.json` → `hooks/register.tsx` — 훅 등록, 상태(atom), 그리기 진입점.
- `hooks/board.ts` — 이 세션의 작업 보드 모델(메인 세션·서브에이전트·팀·워크플로).
- `hooks/view.tsx` — 패널 화면(세션 목록, 보드, 탭, 세부 탭).
- `hooks/sessions.ts` — 이 컴퓨터의 세션 목록(`<config>/sessions/<pid>.json`). 세션은 **pid로 구분**한다
  (같은 sessionId를 두 프로세스가 가질 수 있다). `busy` 말고도 `idle`·대기가 아닌 상태는 모두 작업 중.
- `hooks/workflow.ts`, `hooks/plan.ts` — 워크플로 추적(이벤트 + 세션 폴더의 journal), 스크립트 정적 분석.
- `hooks/controls.ts` — 프롬프트 위 밴드의 모델·effort·워크플로·ultracode 칩.
- `hooks/format.ts` — 토큰·시간·경로·문구 표기.
- `types/index.d.ts` — `$.state` 계약(PluginState). 새 상태 키는 여기 먼저 선언한다.
- `tests/dashboard.test.ts` — `claude-code/testing` 키트 테스트.

## 작업 흐름

```
claude plugin validate .
claude plugin test .
./scripts/typecheck.sh      # API 타입(plugin-authoring 스킬을 한 번 불러오면 생긴다)으로 tsc
```

- 고친 뒤 열려 있는 세션에서는 `/reload-plugins` 로 다시 불러온다(자동 반영 없음).
- 테스트 키트에서 `$.process.run`, `$.fs.*`, `$.session.id` 같은 호출은 테스트가 `on('<event>', ...)` 로 답을 줘야 하고,
  답은 `{ value }` 로 감싼다. `on(...)` 은 테스트가 `$` 를 처음 부르기 전에 모두 등록한다.
- lune 의 `CFrame.lookAt` 같은 건 해당 없음. 화면 미리보기가 필요하면 임시 테스트로 `ui.drawn()` 트리를 텍스트로 펼쳐 본 뒤 지운다.

## 배포(GitHub)

1. `plugin.json` 의 `version` 을 올린다.
2. 공개 전 점검: 올릴 변경에 실명·이메일·이 컴퓨터의 경로·다른 프로젝트 이름·키/토큰이 없는지 확인한다.
   README·테스트의 예시는 `~/work/my-app`, `my-app-38` 처럼 중립적인 이름을 쓴다.
   ```
   git diff --cached | grep '^+' | grep -n -i -E '/Users/|@gmail|gho_|ghp_|sk-ant|PRIVATE KEY'
   ```
3. 커밋은 이 저장소의 익명 작성자(`comdoly-life`, GitHub noreply 이메일, `git config` 에 설정됨)로,
   시간대가 드러나지 않게 `git ci`(= `TZ=UTC git commit`)로 한다. 강제 push 는 하지 않는다.
4. `git push origin main`.
