---
type: index
folder: 01 Pinboard
updated: 2026-10-24
---

# Pinboard Index

AI가 Pinboard 전체를 한 번에 파악하기 위한 색인이다. 목표 노트를 만들거나, 고치거나, 옮기거나, 지울 때마다 이 파일을 같은 작업 안에서 갱신한다. 규칙은 `AGENTS.md`의 「인덱스 규칙」을 따른다.

## 구조

```
01 Pinboard/
├── AGENTS.md            운영 규칙
├── Pinboard Index.md    이 파일
├── Pinboard.base        Obsidian 표 화면
├── Pinboard.html        목표 시각화 화면 (자동 생성, 손으로 고치지 않음)
├── _build/              build_pinboard.py, pinboard.template.html
├── _Templates/          Main Goal.md, Sub Goal.md
└── 2026/                2026년 목표 노트
```

## 2026

| id | 종류 | 제목 | parent | status | baseline → current → target | due | progress | 수단·연결 |
|---|---|---|---|---|---|---|---|---|
| G-2026-01 | main | AI 사업으로 월 500만원 벌기 | — | active | — | — | 0% (0/2) | 강의 제작, 인스타그램 광고 (프로젝트 연결 예정) |
| G-2026-01.1 | sub | 월 매출 500만원 달성 | G-2026-01 | active | 0 → 0 → 5000000 원/월 | 미정 | 0% | Claude Code 기본 강의 판매 |
| G-2026-01.2 | sub | Claude Code 기본 강의 첫 판매 | G-2026-01 | active | — → 강의 제작 중 → 첫 결제 | 미정 | 0% | 강의 제작 (5시간, 10강) |
| G-2026-02 | main | 건강한 몸 만들기 | — | active | — | — | 0% (0/1) | 최종 목표 78kg |
| G-2026-02.1 | sub | 체중 95kg | G-2026-02 | active | 100 → 100 → 95 kg | 2026-12-31 | 0% | — |
| G-2026-03 | main | 혼팀 브랜드를 AI로 키운다 | — | active | — | — | 0% (0/1) | AI 콘텐츠 파이프라인 구축 (프로젝트 연결 예정) |
| G-2026-03.1 | sub | 인스타그램 팔로워 500명 | G-2026-03 | active | ? → ? → 500 명 | 2026-12-31 | 0% | AI 콘텐츠 파이프라인 |

파일 위치: `01 Pinboard/2026/{id} {제목}.md`

## 미정·확인 필요

- G-2026-01.1: 기한, "한 달 달성인지 몇 개월 유지인지"
- G-2026-01.2: 기한
- G-2026-03.1: 현재 팔로워 수
- 모든 수단: `05 Project Folders`로 프로젝트를 옮긴 뒤 `projects`, `project_ids` 연결

## 변경 기록

최근 항목이 위에 오게 쓴다.

- 2026-10-24: 시각화 화면 `Pinboard.html`과 생성기 `_build/` 추가. 시각화 규칙을 AGENTS.md에 추가.
- 2026-10-24: 2026년 목표 3개(Main) / 4개(Sub) 등록. 목표 노트를 `2026/` 폴더로 이동. 인덱스 생성.
