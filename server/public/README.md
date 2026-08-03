# 관제 화면 (F10)

## 파일

```
index.html              화면 구조 + SVG 평면도 + 목록·이벤트용 <template>
assets/css/console.css  관제 화면 스타일. 상태색 토큰(--st-*)이 여기 있다
assets/js/console.js    상태·렌더·서버 배선
_ds/                    Industry 디자인 시스템 — styles.css · readme.md · fonts.css · fonts/
```

의존성 없다. 번들러도 설치 단계도 없고, 브라우저가 이 네 개만 받으면 뜬다.
바탕·타이포·간격·그림자는 전부 `_ds/styles.css`의 토큰에서 온다.

## 어디서 왔나

claude.ai/design 프로젝트 **`관제 화면 대시보드 디자인`**
(`794c8c02-834c-400f-92e6-4f9ac9bb5b30`)에서 옮겼다. **디자인 프로젝트는 시각 기준이지
런타임이 아니다** — 원본은 `.dc.html`이라는 자체 포맷이라 그대로 돌리려면 React와 70KB짜리
전용 런타임이 붙고, 로직이 `new Function`으로 평가돼 타입체크·린트·테스트가 전부 비껴간다.
그래서 마크업은 표준 HTML로, 로직은 평범한 ES 모듈로 옮겼다.

**SVG 평면도만 원본에서 그대로 가져왔다.** 좌표가 손으로 그린 도면이라 다시 만들 이유가 없다.

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

## 도면과 map.json은 한 몸이다

도면 SVG는 `viewBox="0 0 3200 2000"`에 **100px = 1m**로 그려져 있고, SVG y축이 아래로 자라므로
`world_y = 20 - svg_y/100`으로 뒤집힌다. `server/map.json`의 구역 사각형은 전부 이 도면에서
뽑은 것이다. **도면을 고치면 `map.json`도 같이 고쳐야 한다** — 안 그러면 마커가 방 안이 아니라
벽 속에 찍히고, 목록의 구역명과 그림이 따로 논다.

## 같은 폴더의 다른 화면

`recon/` — 사고 기록 조작용 내부 화면. 아직 예전 다크 톤이고 `assets/css/base.css`를 쓴다.
관제 화면과 스타일을 공유하지 않는다.
