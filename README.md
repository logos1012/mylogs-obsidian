# MyLogs for Obsidian

불렛저널을 바탕으로 만든 개인 기록·계획 시스템 **MyLogs**의 Obsidian 플러그인입니다.
화면에서 고치면 볼트의 마크다운 파일에 바로 반영됩니다. 정본은 언제나 `.md` 파일이고, 플러그인은 그 파일을 읽고 쓰는 **창**입니다. 플러그인을 꺼도 데이터는 그대로 남습니다.

> 현재 버전 **0.2.0**: Daily Pad, Pinboard, Wall Calendar, Desk Calendar 화면이 들어 있습니다.
> Logbook, Drawer, Shelf 화면은 파일 형식이 정해지면 추가합니다.

## 화면과 명령

| 화면 | 명령 | 하는 일 |
|---|---|---|
| Daily Pad | "Daily Pad 열기" | 오늘 페이지. Desk Calendar 오늘 칸 연동, 섹션별 편집 |
| Pinboard | "Pinboard 열기" | 연간 목표. 현재 값 입력 → 진척률 자동 계산, 상태 변경, 진척 기록 추가, 인덱스 자동 갱신 |
| Wall Calendar | "Wall Calendar 열기" | 12개월 미래 기록. 항목 추가·체크·취소, 다른 달로 드래그, Desk Calendar로 보내기 (지난달은 읽기 전용) |
| Desk Calendar | "Desk Calendar 열기", "새 달 만들기" | 주마다 [이번 주 할 일 \| 월~일]. 드래그 앤 드롭 3단계 배정(이달 중 → 이번 주 → 날짜), 날짜 사이 이동, 배정 취소, 못 한 일 다섯 선택지(다른 날·미래로·서랍에·쪼개기·놓아주기)와 세 번째 미룰 때 질문 |

모든 쓰기는 바뀐 줄만 고치고, 쓰기 직전에 파일이 그새 바뀌지 않았는지 확인합니다.

## Daily Pad 자세히

리본 아이콘이나 명령 팔레트의 **"Daily Pad 열기"** 로 Daily Pad 화면을 엽니다.

- **날짜 이동**: 맨 위의 ◀ / 오늘 / ▶ 와 날짜 선택. 기본은 오늘(기기 시간 기준)입니다. 요일은 Obsidian 언어 설정에 맞춰 화면에만 표시하고, 파일 링크에는 쓰지 않습니다.
- **오늘 페이지 만들기**: 그날 파일이 없으면 빈 화면과 **"오늘 페이지 만들기"** 버튼이 나옵니다. `new_day.py`와 똑같은 틀(frontmatter, 제목, Desk Calendar 임베드 줄, 다섯 섹션)로 파일을 만듭니다.
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
| Pinboard / Wall Calendar 폴더 | `01 Pinboard` / `02 Wall Calendar` (다음 버전에서 사용) |
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
- `test/fixtures/`: 볼트의 테스트 데이터(`#test`) 복사본과 Python 참고 구현의 출력. 파서가 Python과 똑같이 읽는지 비교합니다.

릴리스: `manifest.json`·`package.json`·`versions.json`의 버전을 올리고, 같은 이름의 태그(예: `0.1.1`, 앞에 `v` 없음)를 push하면 GitHub Actions가 `main.js`, `manifest.json`, `styles.css`를 릴리스에 올립니다.
