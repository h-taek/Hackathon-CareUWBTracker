# 관제 화면 (F10)

## 파일

```
index.html              화면 구조 + 목록·이벤트용 <template>
assets/css/console.css  관제 화면 스타일. 상태색 토큰(--st-*)이 여기 있다
assets/js/console.js    상태·렌더·서버 배선
assets/floorplan/*.svg  층별 2D 도면. 층 하나에 파일 하나다
_ds/                    Industry 디자인 시스템 — styles.css · readme.md · fonts.css · fonts/
```

의존성 없다. 번들러도 설치 단계도 없고, 브라우저가 이것들만 받으면 뜬다.
바탕·타이포·간격·그림자는 전부 `_ds/styles.css`의 토큰에서 온다.

## 어디서 왔나

claude.ai/design 프로젝트 **`관제 화면 대시보드 디자인`**
(`794c8c02-834c-400f-92e6-4f9ac9bb5b30`)에서 옮겼다. **디자인 프로젝트는 시각 기준이지
런타임이 아니다** — 원본은 `.dc.html`이라는 자체 포맷이라 그대로 돌리려면 React와 70KB짜리
전용 런타임이 붙고, 로직이 `new Function`으로 평가돼 타입체크·린트·테스트가 전부 비껴간다.
그래서 마크업은 표준 HTML로, 로직은 평범한 ES 모듈로 옮겼다.

**SVG 평면도만 원본에서 그대로 가져왔다.** 좌표가 손으로 그린 도면이라 다시 만들 이유가 없다.
그 도면이 지금 `assets/floorplan/f1_care.svg`이고, 나머지 층은 그 골격 위에 가벽과 실 구성을
바꿔 그렸다.

디자인이 바뀌면 바뀐 부분만 옮긴다. 원본과 대응은 이렇다.

| 원본 | 여기 |
| --- | --- |
| `<x-dc>` 템플릿의 인라인 style | `console.css`의 클래스 |
| `{{ 값 }}` 바인딩 | `console.js`의 `render()` |
| `<sc-for>` | `<template>` 복제 (`tplMarker` · `tplRoster` · `tplEvent` · `tplFloor`) |
| `<sc-if>` | `hidden` 속성 |
| `style-hover="…"` | `:hover` 규칙 |

## 원본에 없거나 다른 것

- **클라이언트 시뮬을 안 옮겼다.** 원본에는 가짜 인원 10명과 복도를 왕복하는 보행자, 화면에서
  경보를 만드는 `fire()`가 있다. 서버 없는 디자인 편집기에서 화면을 보려던 장치다. 우리는
  서버에 진짜 시뮬레이터가 있고(`--source sim`), **경보를 내는 곳은 감지기 하나뿐이어야 한다.**
- **배선** — `/map`(좌표계) · `/stream` SSE(`position`·`alert`) · `/tags` · `/clips` ·
  `/events`(지난 기록) · `/inject-fall`(데모 버튼).
- **끊김 판정** — 서버는 태그가 죽었다고 알려주지 않고 프레임이 끊길 뿐이라, 마지막 수신에서
  4초로 화면이 판정한다.
- **상태색** — Industry는 단색 액센트라 위험 상태를 표현할 색이 없다. `--st-ok` `--st-alarm`
  `--st-off` `--st-sel` `--st-priv`를 `console.css`에 더했다(`docs/plan/impl/01_design-ui-list.md` §2.2).
- **폰트** — `_ds/styles.css`가 상류와 한 줄 다르다. Google Fonts `@import`를 로컬
  `fonts.css`로 돌렸다. 현장 네트워크가 끊겨도 Barlow가 뜬다.

## 도면과 map.json은 층마다 한 몸이다

도면 SVG는 `viewBox="0 0 3200 2000"`에 **100px = 1m**로 그려져 있고, SVG y축이 아래로 자라므로
`world_y = 20 - svg_y/100`으로 뒤집힌다. **층 하나에 도면 하나이고**, `server/map.json`의 그 층
`zones` 사각형은 전부 그 도면에서 뽑은 것이다. **도면을 고치면 그 층 `zones`도 같이 고쳐야 한다** —
안 그러면 마커가 방 안이 아니라 벽 속에 찍히고, 목록의 구역명과 그림이 따로 논다.

```
assets/floorplan/f1_care.svg   ↔ map.json floors[F1].zones
assets/floorplan/f2_care.svg   ↔ map.json floors[F2].zones
assets/floorplan/f3_rehab.svg  ↔ map.json floors[F3].zones
assets/floorplan/f4_admin.svg  ↔ map.json floors[F4].zones
```

**이름 어긋남은 테스트가 잡는다.** 도면 글자는 `301호`인데 라벨이 `201호`인 상태는 두 글자가
한 화면에 같이 안 떠서 눈으로 못 잡는다. `test/map/floorplan-labels.test.ts`가 도면의
`id="roomLabels"` 그룹과 그 층 `zones[].label`을 대조한다 — **새 실명을 그릴 때는 그 그룹 안에
넣는다.** 밖에 있는 보조 표기(`4인실`·`위험구역`)는 구역이 아니라 설명이므로 대조하지 않는다.

**도면은 `<img>`가 아니라 받아서 DOM에 심는다**(`console.js`의 `showPlan`). `<img>`에 물린 SVG는
브라우저가 격리 문서로 그려서 이 페이지의 웹폰트를 못 쓴다 — 실명이 전부 기본 sans-serif로
떨어진다. 층마다 한 번만 받고 들고 있으며, 나머지 층은 배경으로 미리 받아 둔다.

**사생활 구역 강조(`.zone-alert`)의 위치는 CSS에 없다.** 층마다 도면이 다르므로 좌표를 박아
두면 2층 화장실 낙상에 1층 화장실이 빨개진다. `console.js`가 그 층 구역 사각형에서 계산한다.

## 같은 폴더의 다른 화면

`registry/` — 태그 등록·반납. `operator/` — 관제사 관문. `recon/` — 사고 현장 3D 기록.
셋 다 이 화면과 같은 `_ds/styles.css` 토큰을 쓰고, 상단바·유리 패널·상태 필도 같은 모양이다.

**`recon/`은 영상 등록과 변환 진행만 맡는다.** 사고 목록·상세·3D 뷰어는 이 화면의
`사고 현장 3D` 탭에 있다 — 같은 목록을 두 곳에 두면 어느 쪽이 최신인지 알 수 없어지고,
1.4MB짜리 뷰어 라이브러리가 등록만 하러 온 화면에도 딸려온다. 두 화면은 주소로 오간다.

| 가는 길 | 주소 | 무엇을 한다 |
| --- | --- | --- |
| 관제 → 변환 | `/recon/?incident=<사고id>` | 그 사고에 **고정**된 채 열린다. 화면에서 못 바꾼다 |
| 변환 → 관제 | `/?scene=<사고id>` | 3D 탭을 열고 그 사고의 3D를 띄운다. 주소는 한 번 쓰고 지운다 |

사고를 주소에 싣는 이유는 하나다 — 목록에서 다시 고르게 두면 3번째 사고를 등록하러
들어와 첫 사고에 붙는다. 주소 없이 `/recon`을 열었을 때만 선택기가 나오고, 그때도
**미리 골라 두지 않는다.**
