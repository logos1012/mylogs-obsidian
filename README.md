# MyLogs for Obsidian

불렛저널을 바탕으로 만든 개인 기록·계획 시스템 **MyLogs**의 Obsidian 플러그인입니다.
화면에서 고치면 볼트의 마크다운 파일에 바로 반영됩니다. 정본은 언제나 `.md` 파일이고, 플러그인은 그 파일을 읽고 쓰는 **창**입니다. 플러그인을 꺼도 데이터는 그대로 남습니다.

> 현재 버전 **0.2.0**: Daily Pad, Pinboard, Wall Calendar, Desk Calendar 화면이 들어 있습니다.
> Shelf 화면은 파일 형식이 정해지면 추가합니다.

## 화면과 명령

| 화면 | 명령 | 하는 일 |
|---|---|---|
| Daily Pad | "Daily Pad 열기" | 오늘 페이지. Desk Calendar 오늘 칸 연동, 섹션별 편집 |
| Pinboard | "Pinboard 열기" | 연간 목표. 현재 값 입력 → 진척률 자동 계산, 상태 변경, 진척 기록 추가, 인덱스 자동 갱신 |
| Wall Calendar | "Wall Calendar 열기" | 12개월 미래 기록. 항목 추가·체크·취소, 다른 달로 드래그, Desk Calendar로 보내기 (지난달은 읽기 전용) |
| Desk Calendar | "Desk Calendar 열기", "새 달 만들기" | 주마다 [이번 주 할 일 \| 월~일]. 드래그 앤 드롭 3단계 배정(이달 중 → 이번 주 → 날짜), 날짜 사이 이동, 배정 취소, 못 한 일 다섯 선택지(다른 날·미래로·서랍에·쪼개기·놓아주기)와 세 번째 미룰 때 질문 |
| Project Folders | "Project Folders 열기", "새 프로젝트 만들기", "완료 타임라인 열기" | 프로젝트 칸반(후보 → 진행 → 대기 → 보류 → 완료) ↔ 리스트(area별), 개인/회사 필터. 카드를 끌면 허브 `status`·월별 로그·로그 인덱스·등록부를 함께 갱신, 완료는 Archive Box로 옮김. 14일 넘게 멈춘 진행 카드는 계속/보류/종료를 물음. 새 프로젝트는 템플릿으로 생성 (개발 중) |
| Drawer | "Drawer 열기", "Drawer에 넣기" | `06 Drawer/Drawer.md` 한 파일. 위: 오늘 들어온 후보(Daily Pad 결정 대기의 `#서랍후보`·`#프로젝트후보`, 넣기 / 놓아주기). 가운데: 보류 / 아이디어 / 프로젝트 후보 세 열. 아래: 꺼내기(오늘 / 이달 Desk / Wall·달 선택 / 프로젝트로)와 놓아주기 칸. 카드를 끌어 섹션을 옮기거나 꺼내고(보낸 곳에 `(from:: Drawer)` 줄, Drawer 줄은 `[>] → [[보낸 곳]]`), 놓아주면 `[-] (why::)`. `when::` 칩이 목표 id면 Pinboard로, `reviewed` 90일 지나면 "아직도 원하나요?". 모든 쓰기는 「변경 기록」 한 줄 + `updated` (개발 중) |
| My Life | "My Life 열기" | 지나간 시간의 기록(`08 My Life/`). 날짜를 고르고 **오늘 / 이번 주 / 이번 달 / 올해** 탭으로 그날의 Daily, 그 주의 Weekly(ISO 주), 그 달의 Monthly, 그 해의 Yearly를 섹션 카드로 읽음. frontmatter 숫자(세션·항목·놓아줌·걸러냄·상태)는 한 줄 요약, `#sample`·`sample: true`는 「샘플」 표시, 카드 접기는 탭별로 기억. 파일은 Hermes가 쓰므로 **읽기 전용**이고 「만들기」 버튼이 없음. 예외는 Weekly 이상 `## 사용자 한마디`만 — 여기서 쓰면 그 섹션만 저장. "Daily Pad 열기"로 같은 날짜의 Daily Pad를, "Diary 열기"로 Diary 화면을, Daily Pad의 책 아이콘으로 다시 My Life를 연다. (예전 Diary 탭의 깨달음·감상·로그 모아 보기는 Diary 화면 재료 패널의 「My Life에서」로 옮겼다) |
| Toolbox | "Toolbox 열기", "새 스킬 만들기" | `11 Toolbox/` 스킬 등록부. 스킬은 세 종류(frontmatter `kind`, 없으면 작업)라 화면도 위에서부터 **운영 · 도구 · 작업** 세 구역, 열은 등록부의 그 표와 같음 — 운영: 이름 · slug · 범위 · 상태 · 마지막 검토 / 도구: 이름 · slug · 부르는 말 · 담당 · 상태 · 마지막 검토 / 작업: 이름(파일 열기) · 하는 일(「목적」 첫 줄) · 트리거/schedule · 출력 · 상태 · 마지막 실행·결과 · 마지막 검토. 상태: 작업 **멈춤 / 시험 / 사용** 3단, 도구 **멈춤 / 사용** 2단(시험·사용은 무엇이 켜지는지 보여 주고 확인; 스킬 frontmatter `status`·`updated`, 등록부 상태 칸, 변경 기록 한 줄), 운영은 배지만(항상 적용). **지금 실행**(작업만)은 등록부 「실행 요청」에 `- [ ] T-NN (requested:: 시각)`을 붙이고(실행은 Hermes), 대기 건은 배지, 처리된 `[x]`는 7일 동안 흐리게. 작업의 `last_run` 없거나 90일 지남 → "아직도 쓰나요?", 모든 종류의 `last_reviewed` 90일 지남 → "검토할 때", `last_result` 실패 → 빨간 점과 이유, 20개 초과 → 머리 알림. 우클릭: 수정(종류·이름·slug·description과 종류별 칸; 종류를 바꾸면 확인 뒤 등록부 행이 그 표로 옮겨짐, slug·description을 바꾸면 Hermes 스텁을 다시 맞추라는 안내) / 폐기(폐기일·이유 → 「폐기」 표로, 파일은 그대로). 새 스킬은 종류부터 고르고 `_Templates/스킬.md`로 종류별 본문 섹션과 함께 생성(다음 `T-NN`, slug 검사, 작업·도구 `멈춤` / 운영 `사용`(확인), 그 종류 표에 행). 파일은 있는데 행이 없으면 "등록부에 없음" + 등록, 행이 다른 종류 표에 있으면 「옮기기」, 행만 있으면 취소선. 옛 「스킬」 표 하나짜리 등록부도 작업으로 읽음 |
| Diary | "Diary 열기", "Diary 오늘 쓰기" | `09 Diary/` — **내가 자기 언어로 쓰는 글**. Day One식 3단: 왼쪽 **타임라인**(월 헤더, 요일·날짜 큰 라벨, 제목, 미리보기 2줄, 첫 사진 썸네일, 시각·태그·장소 한 줄, 최신순, `pinned`는 맨 위; 전체 / ★ / 태그 / 연도 필터; 캘린더 띠에 쓴 날 색칠·첫 사진·연속 일수), 가운데 **에디터**(본문 폭 680px·큰 명조체; 첫 줄 `# 제목`이 frontmatter `title`로, 저장마다 `updated`; 시각·장소·날씨·태그는 위에 흐린 한 줄, 누르면 수정; 사진 붙여넣기·드롭 → `99 작업실/첨부/{YYYY-MM}/{YYYY-MM-DD HHMM} {NN}.{ext}`에 저장하고 `![[…]]` 삽입; Daily Pad와 같은 디바운스 자동 저장과 충돌 안내; 미리보기 전환), 오른쪽 **재료 패널**(접을 수 있고 기억: ① 오늘 Daily Pad 끼적임·메모·로그 ② 어제 My Life Daily 깨달음·감상·열린 질문 ③ 그날의 기록 — 지난 해 같은 월-일 엔트리 ④ 오늘의 질문 — `프롬프트.md`에서 날짜 시드로 하나, 90일 안에 답한 질문은 제외, 「답하기」는 `prompt`와 `> 질문` 첫 줄로 새 엔트리 ⑤ My Life에서 — 그 달 Daily·Monthly의 깨달음·감상·로그 원문). 재료의 「+ from」은 엔트리 `from`에 링크만 더하고 본문에는 넣지 않는다. **오늘 쓰기**는 `_Templates/엔트리.md`로 `{YYYY}/{YYYY-MM}/{YYYY-MM-DD HHMM}.md`(같은 분이면 `-2`)를 만들고 커서를 본문에. 저장·생성 때 등록부 `Diary Index.md` 「엔트리」 행과 「월별」(달·엔트리·쓴 날)을 갱신(변경 기록은 안 씀), 우클릭 ★·고정·삭제(확인 → 파일과 첨부를 휴지통, 행 제거, 변경 기록 `삭제 「제목」 (날짜)`). 플러그인은 본문을 한 글자도 쓰지 않는다 |

모든 쓰기는 바뀐 줄만 고치고, 쓰기 직전에 파일이 그새 바뀌지 않았는지 확인합니다.

## Daily Pad 자세히

리본 아이콘이나 명령 팔레트의 **"Daily Pad 열기"** 로 Daily Pad 화면을 엽니다.

- **날짜 이동**: 맨 위의 ◀ / 오늘 / ▶ 와 날짜 선택. 기본은 오늘(기기 시간 기준)입니다. 요일은 Obsidian 언어 설정에 맞춰 화면에만 표시하고, 파일 링크에는 쓰지 않습니다.
- **오늘 페이지 만들기**: 그날 파일이 없으면 빈 화면과 **"오늘 페이지 만들기"** 버튼이 나옵니다. `new_day.py`와 똑같은 틀(frontmatter, 제목, Desk Calendar 임베드 줄, 다섯 섹션)로 파일을 만듭니다.
- **Flywheel** (`12 Flywheel/Flywheel.md`): 새 날을 만들 때 `status:: 사용`인 요소를 `## 오늘 할 일` 맨 위에 `- [ ] F-1 이름 — 최소 (flywheel:: F-1)`로 넣습니다(`new_day.py`와 같음; 파일이 없으면 넣지 않음). 이 줄은 체크하거나 그대로 두기만 하고 못 한 일 메뉴 대상이 아닙니다. 줄 옆에 이번 주(ISO 주, 월~일) 수행 **`n/7`** 배지가 붙고, Tear-off가 `(missed:: N)`을 붙인 줄은 빨간 점이 보입니다. 플러그인은 `Flywheel.md`를 읽기만 합니다.
- **Desk Calendar에서 온 일** (맨 위 고정): `03 Desk Calendar/<YYYY>/<YYYY-MM>.md`의 `### YYYY-MM-DD` 칸을 읽어 할 일·행사·메모를 보여 줍니다.
  - 체크박스를 누르면 **Desk Calendar 파일의 그 줄**에서 `[ ]` ↔ `[x]` 글자 하나만 바뀝니다.
  - 줄이 그사이 바뀌었으면 내용으로 다시 찾고, 못 찾으면 알림을 띄운 뒤 다시 불러옵니다. 추측해서 고치지 않습니다.
  - `[>]` 옮김, `[-]` 놓아줌은 읽기 전용입니다.
  - `(goal:: …)`는 목표 칩, `#태그`, `(why:: …)`·`(moved:: …)`·`(from:: …)` 필드, `#test` 표시를 함께 보여 줍니다.
- **결정 대기**: 파일에 `## 결정 대기` 섹션이 있을 때만 나타납니다. 체크하면 Daily Pad 파일에 저장됩니다.
- **섹션 칸**: 오늘 할 일 · 메모 · 로그 · 끼적임 · 자료. 넓은 창에서는 여러 열로, 좁은 창에서는 한 열로 배치됩니다.
  - 칸을 누르거나 "편집"을 누르면 그 섹션의 마크다운만 편집합니다.
  - 쓰는 즉시(설정한 지연 뒤) **그 섹션 본문만** 바꿔 저장합니다. 파일의 나머지는 한 글자도 건드리지 않습니다.
  - Esc를 누르거나 칸 밖을 누르면 보기 모드로 돌아갑니다.
  - 오늘 할 일에는 **"할 일 추가"** 입력칸이 있어 `- [ ] 내용`을 바로 붙입니다.
  - 저장할 때 frontmatter의 `updated`를 오늘 날짜로 바꿉니다. 그 한 줄만 고치고 다른 frontmatter는 다시 쓰지 않습니다.
- **실시간 반영**: Hermes 같은 다른 기기가 Google Drive 동기화로 파일을 바꾸면 해당 칸만 다시 그립니다.
  - 편집 중이고 아직 저장하지 않은 내용이 있으면 덮어쓰지 않고, 그 칸에 **"파일에 새 내용이 있어요 · 다시 불러오기"** 를 띄웁니다. "내 내용으로 저장"을 고를 수도 있습니다.
- 라이트·다크 테마를 모두 지원합니다. 라이트 모드는 Desk Calendar HTML과 같은 흰 종이 느낌입니다.

## BRAT로 설치하기

공개 저장소라서 GitHub 토큰은 필요 없습니다. Obsidian → 설정 → 커뮤니티 플러그인에서 **BRAT**(Obsidian42 - BRAT)를 설치하고 켠 뒤 아래대로 추가합니다.

### 플러그인 추가

1. 설정 → **BRAT** → **Add Beta plugin**
2. 저장소에 `logos1012/mylogs-obsidian`을 입력합니다. 버전은 최신(0.1.0)을 고릅니다.
3. **Add Plugin**을 누릅니다.
4. 설정 → 커뮤니티 플러그인에서 **MyLogs**를 켭니다.
5. 왼쪽 리본의 노트 아이콘이나 명령 팔레트의 **"Daily Pad 열기"** 로 엽니다.

새 버전이 나오면 BRAT의 "Check for updates"로 업데이트합니다.

## 볼트 폴더 구조

기본값은 아래와 같습니다. 폴더 이름은 설정에서 바꿀 수 있습니다.

```
<볼트>/
├── AGENTS.md                       줄 형식(체크박스, 행사, 메모, 필드)의 정본
├── MyLogs Plugin 계획.md            플러그인 계획
├── 01 Pinboard/                    (다음 버전)
├── 02 Wall Calendar/               (다음 버전)
├── 03 Desk Calendar/
│   └── 2026/
│       └── 2026-10.md              ## W43 (10/19~10/25) → ### 2026-10-24 → 줄들
└── 04 Daily Pad/
    └── 2026/
        └── 2026-10-24.md           하루 = 파일 하나
```

Daily Pad 한 장의 모양 (`new_day.py`와 같음):

```markdown
---
type: daily-pad
date: 2026-10-24
desk_calendar: "03 Desk Calendar/2026/2026-10.md"
torn_off: false
updated: 2026-10-24
---

# 2026-10-24 (토)

![[03 Desk Calendar/2026/2026-10#2026-10-24]]

## 오늘 할 일

## 메모

## 로그

## 끼적임

## 자료
```

줄 형식은 볼트 루트 `AGENTS.md`의 「줄 형식 (모든 폴더 공통)」을 따릅니다.

| 줄 | 뜻 |
|---|---|
| `- [ ] 내용` / `- [x] 내용` | 할 일 예정 / 완료 |
| `- [>] 내용 → 보낸 곳` | 옮김 |
| `- [-] 내용 (why:: 이유)` | 놓아줌·취소 |
| `- 14:00 회의`, `- 한글날 #행사` | 행사 |
| `- 내용` | 메모 |
| `- ~~19:00 모임~~` | 취소한 행사 |

## 설정

| 항목 | 기본값 |
|---|---|
| Daily Pad 폴더 | `04 Daily Pad` |
| Desk Calendar 폴더 | `03 Desk Calendar` |
| Pinboard / Wall Calendar 폴더 | `01 Pinboard` / `02 Wall Calendar` |
| Project Folders / 완료 보관 폴더 | `05 Project Folders` / `10 Archive Box/Projects` |
| Drawer 파일 | `06 Drawer/Drawer.md` |
| My Life 폴더 | `08 My Life` (`01 Daily/<YYYY>/<YYYY-MM>/`, `02 Weekly/<GGGG>/`, `03 Monthly/<YYYY>/`, `04 Yearly/`) |
| Toolbox 폴더 | `11 Toolbox` (`<이름>.md`, `Toolbox Index.md`, `_Templates/스킬.md`) |
| Diary 폴더 | `09 Diary` (`<YYYY>/<YYYY-MM>/<YYYY-MM-DD HHMM>.md`, `Diary Index.md`, `_Templates/엔트리.md`, `99 작업실/프롬프트.md`·`첨부/`) |
| Flywheel 폴더 | `12 Flywheel` (`Flywheel.md` — 읽기만; `status:: 사용` 요소를 새 Daily Pad 오늘 할 일 맨 위에) |
| 섹션 이름 | `오늘 할 일`, `메모`, `로그`, `끼적임`, `자료`, `결정 대기` |
| 자동 저장 지연 | 800 ms |
| 테스트 데이터 표시 | 켬 (`#test` 항목에 작은 표시) |

## 계획

전체 계획은 볼트의 **`MyLogs Plugin 계획.md`** 에 있습니다. 화면마다 연결할 데이터, 기본 방침(정본은 `.md`, 줄·섹션 하나만 고침, Hermes와 충돌하지 않음, 다국어), 단계별 체크리스트가 정리되어 있습니다. 이 플러그인은 그 문서의 「### 4. Daily Pad」를 먼저 구현한 것입니다.

다음 버전에서 할 일:

- Pinboard, Wall Calendar, Desk Calendar 화면 (Desk Calendar 드래그 앤 드롭 배정 포함)
- 못 한 일 다섯 버튼: 다른 날 / 미래로 / 서랍에 / 쪼개기 / 놓아주기
- 인덱스(`Daily Pad Index.md`, `Desk Calendar Index.md`) 갱신
- 화면 문구 번역 파일(i18n)

## 개발

```bash
npm install
npm test        # 파서·섹션 쓰기 단위 테스트 (Node 22.18 이상, TypeScript를 그대로 실행)
npm run build   # 타입 검사 + main.js 번들
npm run dev     # 고칠 때마다 다시 빌드
```

- `src/parser.ts`: 줄 형식 파서. `03 Desk Calendar/_build/build_desk_calendar.py`를 TypeScript로 옮겼습니다.
- `src/writer.ts`: 체크박스 한 글자 바꾸기, 섹션 본문 바꾸기, frontmatter 한 줄 바꾸기, 새 날 틀.
- `src/view.ts`: Daily Pad 화면 (`ItemView`, 보기 형식 `mylogs-daily-pad`).
- `src/settings.ts`: 설정 탭.
- `src/desk/`, `src/projects/`, `src/drawer/`: 화면마다 `model.ts`(읽기)·`ops.ts`(순수 쓰기 변환)·`actions.ts`(볼트 쓰기)·`view.ts`·`register.ts`. 순수 모듈만 테스트합니다.
- `src/mylife/`: My Life 화면. `model.ts`(경로·ISO 주·섹션 파싱·사용자 한마디 쓰기·깨달음·감상 모음, 순수)·`view.ts`·`register.ts`. 픽스처는 볼트의 김하루 샘플(`test/fixtures/my-life/`).
- `src/diary/`: Diary 화면. `model.ts`(엔트리 파싱·미리보기·타임라인 묶기·파일 이름·제목↔frontmatter·질문 고르기·그날의 기록·연속 일수·from 링크, 순수)·`ops.ts`(등록부 「엔트리」·「월별」·삭제 기록, 순수)·`actions.ts`(볼트 쓰기)·`view.ts`·`register.ts`. 픽스처는 김하루의 가상 엔트리(`test/fixtures/diary/`).
- `src/toolbox/`: Toolbox 화면. `model.ts`(스킬 파싱·다음 id·배지·등록부 행 대조, 순수)·`ops.ts`(등록부 표·실행 요청·상태·폐기·수정 변환, 순수)·`actions.ts`·`modals.ts`·`view.ts`·`register.ts`. 픽스처는 볼트의 `11 Toolbox/` 복사본(`test/fixtures/toolbox/`).
- `src/flywheel/model.ts`: Flywheel 모델(순수, 화면 없음). `Flywheel.md` 파싱, Daily Pad 줄 만들기(`new_day.py`의 `flywheel_lines()` 이식), `(flywheel::)`·`(missed::)` 읽기, 주간 `n/7` 집계. 픽스처는 볼트의 `12 Flywheel/Flywheel.md` 복사본(`test/fixtures/flywheel/`)과 그것으로 만든 `new_day.py` 출력.
- `test/fixtures/`: 볼트의 테스트 데이터(`#test`) 복사본과 Python 참고 구현의 출력. 파서가 Python과 똑같이 읽는지 비교합니다.

릴리스: `manifest.json`·`package.json`·`versions.json`의 버전을 올리고, 같은 이름의 태그(예: `0.1.1`, 앞에 `v` 없음)를 push하면 GitHub Actions가 `main.js`, `manifest.json`, `styles.css`를 릴리스에 올립니다.
