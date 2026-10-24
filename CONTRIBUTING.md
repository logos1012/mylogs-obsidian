# 작업 방식

## 브랜치

- `main`: 릴리스된 상태만 둔다. BRAT 사용자가 받는 코드다.
- `dev`: 다음 버전을 만드는 곳. 평소 작업은 여기서 한다.
- 큰 기능은 `dev`에서 `feat/<이름>` 브랜치를 따서 만들고 `dev`로 합친다.

## 릴리스 순서

1. `dev`에서 `npm test`, `npm run build`가 통과하는지 확인한다.
2. `manifest.json`, `package.json`, `versions.json`의 버전을 올리고 `CHANGELOG.md`에 적는다.
3. `dev`를 `main`에 합친다.
4. `main`에서 버전과 같은 이름으로 태그를 만들고 올린다. 예: `git tag 0.3.0 && git push origin 0.3.0`
5. GitHub Actions가 빌드해서 Release에 `main.js`, `manifest.json`, `styles.css`를 붙인다.

## 원칙

- 데이터 형식의 정본은 MyLogs 볼트의 `AGENTS.md`들이다. 형식이 바뀌면 볼트 문서를 먼저 고치고 플러그인을 맞춘다.
- 계획과 체크리스트: 볼트의 `MyLogs Plugin 계획.md`
