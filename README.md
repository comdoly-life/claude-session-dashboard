# Claude Session Dashboard

Claude Code 세션에서 지금 돌아가는 모든 작업을 한 창에서 보여 주는 mod입니다. 같은 폴더의 다른 세션과,
한 단계 위로 올라가면 이 컴퓨터의 모든 Claude Code 세션도 폴더별로 보고 메시지를 보내거나 끝낼 수 있습니다.
메인 세션, 서브에이전트, 에이전트 팀, 워크플로와 그 에이전트마다 무엇을 하고 있는지, 진행 상황(완료/전체),
쓴 토큰과 실행 시간을 표시하고, 프롬프트 위 세 줄에는 5시간·주간 한도 막대와 남은 %, 모델·effort 버튼, 워크플로·울트라코드 버튼을 띄웁니다. (화면 문구는 한국어)

**설치 안내 페이지: https://comdoly-life.github.io/claude-session-dashboard/**

A Claude Code mod: a list of the Claude Code sessions running in this folder (one level up, every session on
the machine by folder, with this session marked, each one messaged or ended from its tab), and a live pane of everything running in the session — the main session, subagents, agent teams
and workflows — with what each is doing, progress (done/total), tokens and run time, detail tabs, and three rows above
the prompt: the 5-hour / weekly limit bars with what is left, chips for the model and effort, and toggles for
workflows and ultracode. The UI
text is in Korean.

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

프롬프트 위 세 줄(대괄호는 버튼, 선택된 것은 밝은 색 배경):

```
5시간 ████████████░░░░░░░░░░░░ 잔여 52%   주간 ███████████████████░░░░░ 잔여 19%
모델 [페이블] [오푸스 5.5] [소넷] [하이쿠]  effort [low] [med] [high] [xhigh] [max]
워크플로 [ON]  울트라코드 [OFF]
```

## 설치 / Install

공식 마켓플레이스에는 올라가 있지 않습니다. 저장소를 받아 내 컴퓨터의 마켓플레이스로 등록한 뒤 설치합니다.
셸(터미널)에서 차례로 실행하세요. Claude Code 2.1.300 이상과 `git` 이 필요합니다.

```
git clone https://github.com/comdoly-life/claude-session-dashboard.git ~/claude-session-dashboard
claude plugin marketplace add ~/claude-session-dashboard
claude plugin install session-dashboard@claude-session-dashboard
```

이미 열려 있는 Claude Code 세션에서는 `/reload-plugins` 로 불러오고, 아니면 새 세션을 시작합니다.

업데이트(새 코드를 받은 뒤 열린 세션에서 `/reload-plugins`):

```
git -C ~/claude-session-dashboard pull
claude plugin update session-dashboard@claude-session-dashboard
```

삭제:

```
claude plugin uninstall session-dashboard@claude-session-dashboard
claude plugin marketplace remove claude-session-dashboard
```

Not on the official marketplace: clone the repository, add the clone as a local marketplace, then install
(the three commands above, run in a shell).

## 화면

- **세션 목록(목록 탭)**: 대시보드는 **이 폴더의 세션**에서 시작합니다. 같은 폴더에서 실행 중인 Claude Code 세션을
  한 줄씩 보여 주고, 그 아래에 이 세션의 작업 보드가 이어집니다.

  ```
   ↑ 모든 세션  ~/work/my-app · 세션 2개
  ● my-app-38 [이 세션]                    작업 중 · 1m00s
  ● my-app-41                              대기 중 · 3m00s

  이 세션의 작업 · 1개 실행 중          ↑입력 ↓출력 · 시간
  ☐ 메인 세션 (2/5)                              ↑230k ↓4.1k
  ```

  - 지금 쓰는 세션은 하늘색 글자와 `[이 세션]` 표시로 구분합니다. 앞의 점은 작업 중(초록), 대기 중(회색), 응답 기다림(노랑).
    셸 명령을 돌리는 세션(`명령 실행 중`)처럼 쉬지 않는 상태는 모두 작업 중(초록)으로 셉니다.
  - 다른 세션 줄의 오른쪽 `[ 메시지 ]` `[ 종료 ]` 로 탭을 열지 않고 바로 메시지를 보내거나 끝낼 수 있습니다
    (종료는 `[ 한 번 더 ]` 로 바뀐 뒤 다시 눌러야 합니다).
  - 세션은 프로세스(PID)로 구분합니다. 같은 대화를 다른 폴더에서 이어 열어 세션 ID가 같아도 각자 제 폴더에 표시됩니다.
  - `↑ 모든 세션` 을 누르면 한 단계 위로 올라가 이 컴퓨터에서 실행 중인 모든 세션을 폴더별로 봅니다. 이 세션이 있는 폴더가
    맨 위에 하늘색과 `[이 세션]` 으로 표시되고, 폴더 줄을 누르면 그 폴더의 세션 목록으로, `↓ 이 폴더` 는 이 세션의 폴더로 돌아갑니다.

    ```
     ↓ 이 폴더  모든 세션 폴더 2개 · 세션 3개
    ▸ ~/work/my-app · 2개 (1개 작업 중) [이 세션]
      ● my-app-38 [이 세션]                  작업 중 · 1m00s
      ● my-app-41                            대기 중 · 3m00s
    ▸ ~/claude-mods · 1개 (1개 작업 중)
      ● claude-mods-2                            작업 중 · 5s
    ```

  - 다른 세션을 누르면 그 세션 탭이 열립니다: 상태와 그 시간, 폴더, 시작 시각, 종류·버전, PID, 세션 ID.
    - `메시지 보내기`: 프롬프트에 `/dash-send <세션 이름> ` 을 채워 줍니다. 메시지를 이어 쓰고 Enter 를 누르면 그 세션이
      다음 차례에 읽습니다. 직접 `/dash-send <세션 이름 또는 ID> <메시지>` 로 보내도 됩니다.
    - `세션 종료`: 한 번 더 눌러야 끝냅니다(창을 닫은 것과 같은 SIGTERM). 대화 기록은 남아 그 폴더에서
      `claude --resume <세션 ID>` 로 다시 열 수 있습니다. 이 세션 자신은 끝낼 수 없습니다.
  - 내 세션 줄을 누르면 메인 세션 탭이 열립니다. 목록은 대시보드가 보이는 동안 5초마다 새로 읽습니다.
- **보드(이 세션의 작업)**: 메인 세션, 실행 중인 항목, 완료된 항목 순서로 한 줄씩.
  - 앞의 체크 상자는 실행 중 ☐, 완료 ☑(초록 글자), 실패·중단 ☒(빨간 글자).
  - 제목 옆 `(완료/전체)`: 워크플로는 스크립트를 미리 읽어 센 에이전트 수(결과에 따라 늘어나면 `+`),
    메인 세션·서브에이전트는 할 일 목록, 팀은 작업 목록, 목록이 없는 에이전트는 `0/1 → 1/1`.
  - 오른쪽에 쓴 토큰(`↑입력 ↓출력`)과 실행 시간, 실행 중인 항목 아래 줄에 지금 하는 일을 짧게
    (도구 이름이나 실행 경로 대신 "plan.ts 읽는 중", "코드 찾는 중"처럼).
- **세부 탭**: 항목을 클릭하면 탭이 생깁니다. 탭의 `×` 나 맨 위 `[ × 닫기 ]` 로 닫고, `← 목록` 으로 목록으로 돌아갑니다.
  - 맨 위에 **맡은 일**(받은 지시·요청·워크플로 설명)과 **지금**(하고 있는 일) 두 줄.
  - 상태와 시간, 종류, 토큰 내역(새 입력·캐시 읽기·캐시 쓰기·요청 수), 할 일 체크리스트, 최근 호출, 마지막 응답.
  - 워크플로 탭은 진행 막대와 단계별 진행(`Read 3/3 ✓ › Summarize 0/1`), 에이전트 목록(클릭하면 그 에이전트 탭).
- **프롬프트 위 세 줄**
  - 첫 줄 `5시간 ████░░░░ 잔여 52%   주간 …`: 5시간·주간(·지출) 한도. 막대는 전체 중 쓴 만큼을 색으로 칠하고,
    뒤에 남은 비율을 %로 씁니다. 색은 남은 양이 60% 이상이면 초록, 그 아래로 내려갈수록 주황 → 주홍 → 진한 빨강.
    터미널이 좁으면 막대를 줄이거나 빼고 숫자만 남깁니다.
  - 둘째 줄은 모델·effort, 셋째 줄은 워크플로·울트라코드 버튼입니다. 고르지 않은(꺼진) 버튼은 회색 배경,
    고른(켜진) 버튼은 묶음마다 다른 밝은 색 배경입니다(모델 주황, effort 파랑, 워크플로 초록, 울트라코드 보라).
  - `모델 페이블 오푸스 소넷 하이쿠`: 누르면 그 계열의 최신 모델(별칭 `fable`·`opus`·`sonnet`·`haiku`)로 바꾸고,
    고른 모델은 버전과 함께(`오푸스 5.5`) 표시합니다. Fable 처럼 동의가 먼저 필요한 모델은 `/model` 로 넘깁니다.
  - `effort low med high xhigh max`: `/effort <level>` 과 같습니다. 모델이 지원하지 않는 단계면 그 안내가 뜹니다.
  - `워크플로 ON/OFF`: `/config` 의 Dynamic workflows. 켜져 있으면 "워크플로로 해 줘"처럼 직접 요청할 때 워크플로
    (여러 에이전트에게 나눠 맡기는 방식)를 쓸 수 있고, 끄면 워크플로도 울트라코드도 쓰지 않습니다.
  - `울트라코드 ON/OFF`: `/effort ultracode on|off` (이 세션만). 요청하지 않아도 모든 작업을 워크플로로 돌립니다.
    워크플로가 꺼져 있으면 그것부터 켜고, 울트라코드를 끌 때는 워크플로를 그대로 둡니다.
  - 버튼은 마우스 클릭(전체 화면 모드) 또는 ctrl+x tab 으로 줄에 들어가 Tab·Enter 로 누릅니다. 바뀌는 중인 버튼엔
    `…` 이 붙고, 결과는 토스트로 알립니다. 실행 중인 턴이 있으면 `/effort` 는 그 턴이 끝난 뒤 적용됩니다.
  - 터미널이 좁으면 버튼 묶음이 다음 줄로 넘어갑니다. 직접 `/model`·`/effort`·`/config` 로 바꿔도 따라갑니다.
  - 처음 켤 때와 `/clear` 뒤에는 지금 모델과 그 모델의 effort 를 바로 표시합니다. effort 는 설정에 모델별로 저장된 값
    (`modelSettings.<모델>.effortLevel`), 없으면 `effortLevel`, `CLAUDE_CODE_EFFORT_LEVEL` 이 있으면 그 값이고,
    첫 요청이 나가면 그 요청에 실제로 쓰인 effort 로 맞춥니다.
- `/dash` 로 대시보드 창을 열고 닫습니다. 세션이 시작되면 자동으로 열립니다.

## 동작 방식

- 엔진 이벤트(턴, 도구 호출, 에이전트 시작, `SubagentStart`/`SubagentStop`, 작업 목록)를 받아 세션 메모리에만 기록합니다.
- 워크플로는 이벤트와 함께 세션 폴더의 실행 기록(`~/.claude/projects/<프로젝트>/<세션>/subagents/workflows/<run>/journal.jsonl`)과
  저장된 스크립트를 5초마다 읽어, 플러그인을 다시 불러오기 전에 시작한 실행도 보여 줍니다
  (`HOME`, `CLAUDE_CONFIG_DIR` 환경 변수로 위치를 찾습니다).
- 세션 목록은 Claude Code 가 실행 중인 세션마다 남기는 등록 파일(`~/.claude/sessions/<pid>.json`: 세션 ID, 폴더, 이름,
  상태)을 읽고, `ps` 로 그 프로세스가 아직 살아 있는지 확인해 비정상 종료로 남은 파일은 뺍니다. 메시지는 엔진의
  `$.session.send`(SendMessage 와 같은 전달), 종료는 `kill -TERM <pid>` 이며, 그 전에 PID 가 여전히 Claude Code 인지 확인합니다.
- 네트워크로 아무것도 보내지 않습니다. 플러그인 저장소(`$.store`)에는 한도 기록과 최근 훅 오류만 남깁니다.
- 모델·워크플로 버튼은 `$.config.set`, effort·울트라코드 버튼은 `$.command.run` 으로 엔진의 기본 동작을 그대로 씁니다
  (`/model`·`/effort` 처럼 모델과 effort 는 새 세션의 기본값으로도 저장됩니다). 울트라코드를 켤 때 Dynamic workflows 가
  꺼져 있으면 `$.config.set` 으로 먼저 켭니다.
- 훅에서 오류가 나면 보드 아래에 `⚠` 줄로 보여 줍니다.

## 한계

- 워크플로의 전체 개수는 스크립트를 실행하지 않고 읽어 셉니다. 반복 횟수가 에이전트 결과에 달린 경우
  (찾은 문제마다 검증, `while` 반복 등)는 최소값과 `+` 로 표시하고 실제로 늘어나면 따라갑니다.
- 워크플로 이름, 단계·라벨, 에이전트 설명처럼 스크립트나 모델이 정한 이름은 그대로(대개 영어) 표시합니다.
- 세션 목록은 이 컴퓨터의 세션만 보여 줍니다(원격·클라우드 세션 제외). 다른 세션의 작업 내역(서브에이전트·토큰)은
  그 세션의 대시보드에서만 보입니다. Windows 처럼 `ps` 가 없으면 남은 등록 파일을 걸러내지 못합니다.
- 5시간·주간 한도는 Claude 구독으로 로그인했을 때만 나옵니다(API 키로 쓰면 첫 줄이 없습니다).
- Claude Code 2.1.300 이상의 함수 훅 mod API로 만들었고 2.1.303 에서 시험했습니다.

## 개발

```
claude plugin validate .
claude plugin test .
```

`hooks/register.tsx` 가 훅과 그리기를, `hooks/board.ts` 가 보드 모델, `hooks/view.tsx` 가 화면,
`hooks/workflow.ts`·`hooks/plan.ts` 가 워크플로 추적과 스크립트 분석, `hooks/sessions.ts` 가 세션 목록, `hooks/controls.ts` 가 모델·effort 버튼,
`hooks/format.ts` 가 표기를 맡습니다. `docs/index.html` 은 GitHub Pages 로 내보내는 설치 안내 페이지입니다.
