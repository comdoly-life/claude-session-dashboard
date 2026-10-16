# Claude Session Dashboard

Claude Code 세션에서 지금 돌아가는 모든 작업을 한 창에서 보여 주는 mod입니다.
메인 세션, 서브에이전트, 에이전트 팀, 워크플로와 그 에이전트마다 무엇을 하고 있는지, 진행 상황(완료/전체),
쓴 토큰과 실행 시간을 표시하고, 프롬프트 위에는 5시간·주간 사용 한도 게이지를 띄웁니다. (화면 문구는 한국어)

A Claude Code mod: a live pane of everything running in the session — the main session, subagents, agent teams
and workflows — with what each is doing, progress (done/total), tokens and run time, detail tabs, and 5-hour /
weekly limit gauges above the prompt. The UI text is in Korean.

```
대시보드 · 3개 실행 중                    ↑입력 ↓출력 · 시간
☐ 메인 세션 (2/5)                              ↑230k ↓4.1k
    대시보드 탭 구현 중
☐ 에이전트 팀 alpha (1/4)                  ↑80k ↓6k · 4m10s
    1명 작업 중
  ☐ researcher · 자료 조사 (0/2)           ↑40k ↓3k · 4m10s
☐ 탐색 에이전트 · 코드 구조 탐색 (0/1)     ↑41k ↓2k · 1m20s
    코드 찾는 중
☐ 워크플로 · review-changes (1/3)          ↑50k ↓4k · 1m20s
    2개 실행 중
  ☑ review:bugs (1/1)                      ↑20k ↓2k · 40s
  ☐ review:perf (0/1)                      ↑30k ↓2k · 1m20s
      plan.ts 읽는 중

완료
☑ 범용 에이전트 · 문서 조사 (1/1)          ↑20k ↓1k · 40s
```

## 설치 / Install

Claude Code 터미널 세션의 프롬프트에서:

```
/plugin install session-dashboard --marketplace comdoly-life/claude-session-dashboard
```

셸에서:

```
claude plugin install session-dashboard --marketplace comdoly-life/claude-session-dashboard
```

마켓플레이스를 추가할지 물으면 `y`, 이어서 설치 범위(scope)를 고릅니다. 이미 열려 있는 세션에는 `/reload-plugins` 로 불러옵니다.

## 화면

- **보드(전체 탭)**: 메인 세션, 실행 중인 항목, 완료된 항목 순서로 한 줄씩.
  - 앞의 체크 상자는 실행 중 ☐, 완료 ☑(초록 글자), 실패·중단 ☒(빨간 글자).
  - 제목 옆 `(완료/전체)`: 워크플로는 스크립트를 미리 읽어 센 에이전트 수(결과에 따라 늘어나면 `+`),
    메인 세션·서브에이전트는 할 일 목록, 팀은 작업 목록, 목록이 없는 에이전트는 `0/1 → 1/1`.
  - 오른쪽에 쓴 토큰(`↑입력 ↓출력`)과 실행 시간, 실행 중인 항목 아래 줄에 지금 하는 일을 짧게
    (도구 이름이나 실행 경로 대신 "plan.ts 읽는 중", "코드 찾는 중"처럼).
- **세부 탭**: 항목을 클릭하면 탭이 생깁니다. 탭의 `×` 나 맨 위 `[ × 닫기 ]` 로 닫고, `← 전체` 로 보드로 돌아갑니다.
  - 맨 위에 **맡은 일**(받은 지시·요청·워크플로 설명)과 **지금**(하고 있는 일) 두 줄.
  - 상태와 시간, 종류, 토큰 내역(새 입력·캐시 읽기·캐시 쓰기·요청 수), 할 일 체크리스트, 최근 호출, 마지막 응답.
  - 워크플로 탭은 진행 막대와 단계별 진행(`Read 3/3 ✓ › Summarize 0/1`), 에이전트 목록(클릭하면 그 에이전트 탭).
- **한도 게이지**: 프롬프트 위 한 줄에 5시간·주간(·지출) 사용률, 리셋까지 남은 시간, 지금 속도로 리셋 전에
  다 쓸 것 같으면 경고.
- `/dash` 로 대시보드 창을 열고 닫습니다. 세션이 시작되면 자동으로 열립니다.

## 동작 방식

- 엔진 이벤트(턴, 도구 호출, 에이전트 시작, `SubagentStart`/`SubagentStop`, 작업 목록)를 받아 세션 메모리에만 기록합니다.
- 워크플로는 이벤트와 함께 세션 폴더의 실행 기록(`~/.claude/projects/<프로젝트>/<세션>/subagents/workflows/<run>/journal.jsonl`)과
  저장된 스크립트를 5초마다 읽어, 플러그인을 다시 불러오기 전에 시작한 실행도 보여 줍니다
  (`HOME`, `CLAUDE_CONFIG_DIR` 환경 변수로 위치를 찾습니다).
- 네트워크로 아무것도 보내지 않습니다. 플러그인 저장소(`$.store`)에는 한도 게이지 기록과 최근 훅 오류만 남깁니다.
- 훅에서 오류가 나면 보드 아래에 `⚠` 줄로 보여 줍니다.

## 한계

- 워크플로의 전체 개수는 스크립트를 실행하지 않고 읽어 셉니다. 반복 횟수가 에이전트 결과에 달린 경우
  (찾은 문제마다 검증, `while` 반복 등)는 최소값과 `+` 로 표시하고 실제로 늘어나면 따라갑니다.
- 워크플로 이름, 단계·라벨, 에이전트 설명처럼 스크립트나 모델이 정한 이름은 그대로(대개 영어) 표시합니다.
- Claude Code 2.1.300 의 함수 훅 mod API로 만들고 시험했습니다.

## 개발

```
claude plugin validate .
claude plugin test .
```

`hooks/register.tsx` 가 훅과 그리기를, `hooks/board.ts` 가 보드 모델, `hooks/view.tsx` 가 화면,
`hooks/workflow.ts`·`hooks/plan.ts` 가 워크플로 추적과 스크립트 분석, `hooks/format.ts` 가 표기를 맡습니다.
