# Industry design system

Industry is a wireframe: steel-blue on a light technical ground, Barlow Condensed headings over Barlow, a modular grid, and cards, figures and buttons framed as blueprint objects — square-cornered, hairline-bordered, with "+" registration marks at the corners. Cards and figures stay transparent line drawings; the primary button is the one solid object on the board, an accent fill that keeps the square corners and the marks. Photography is duotoned into the steel accent and icons are thin-stroke.

## How to use this

- Link the one stylesheet from every page — `<link rel="stylesheet" href="styles.css">` (adjust the relative path) — and take every color, font, spacing, radius and shadow from its variables (`var(--color-*)`, `var(--font-*)`, `var(--space-*)`, `var(--radius-*)`, `var(--shadow-*)`). Never hard-code a hex, a font name or a px value the tokens already carry.
- Build with the classes below rather than inventing parallel ones; the component pages are plain HTML, so view source and copy the markup.
- `templates/` holds starting points a consuming project can copy whole.
- The whole system was derived from `theme.json`. To change the look, edit the tokens at the top of `styles.css` — every page, the thumbnail and this guide read from them — and keep `theme.json` and the written guidance in step so they don't drift from what the CSS actually does.

## Direction

Modular grid layouts — content in equal-width cells, strong horizontal and vertical rhythm, visible structure. Cards, buttons and major sections are wireframe objects: square-cornered, thin-bordered, with `+` crosshair corner marks (the `.blueprint` class + four `<i class="corner tl/tr/bl/br">` children) — never soft filled rounded blocks. Images and figures get the same treatment: square, hairline-framed and marked, never rounded or clipped. Wrap hero and inline images in the `.duotone` class — they are desaturated and washed in the accent, like a screen print that re-colors with the theme.

## Color

A light ground (`--color-bg` #f2f2f3) with `--color-text` #1d1f20 and a single accent #5980a6 (this is a mono scheme: no second accent was chosen — the `--color-accent-2-*` variables carry a machine-derived stand-in kept only so both sets resolve; treat them as one role). Each role carries a 100–900 tonal ramp (`--color-neutral-100` … `--color-accent-2-900`) generated in OKLCH on a shared perceptual lightness scale, so the same step of any ramp has the same visual weight. Use the light steps (100–300) for tinted fills, hovers and subtle borders, 500 as the role's base, and the dark steps (700–900) for text on tinted fills and for pressed states; prefer ramp steps over ad-hoc `color-mix()`. For elevation use `--shadow-sm/md/lg` (already tuned to the ground) rather than ad-hoc box-shadows.

## Type

Barlow Condensed for headings over Barlow for body text, loaded as `--font-heading` / `--font-body`. Density 0.85× and radius 4px are already baked into the `--space-*` / `--radius-*` scales — use the variables, not raw numbers.

## Icons

Use Lucide icons (https://lucide.dev), at stroke-width 1.5 for a lighter, more technical look throughout.

## Interaction states

Interactive states are themed, never browser defaults: give every interactive element a `:hover` tint and a pressed state from the accent ramp (one step past the base — `--color-accent-600` on a light ground, `--color-accent-400` on a dark one, or a `color-mix()` tint for outlined/ghost variants), and style keyboard focus with `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }` — never leave the default blue focus ring.

## Components

| Class | What it is | Shown in |
| --- | --- | --- |
| `.btn` with `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-icon`, `.btn-block` | Actions — the primary is a solid accent fill | components/buttons.html |
| `.tag` with `.tag-accent`, `.tag-accent-2`, `.tag-neutral`, `.tag-outline` | Small labels tinted from the ramps (mono palette: accent-2 reads the same as accent) | components/buttons.html |
| `.field` + `label`, `.input`, `.radio` + `.dot`, `.seg` + `.seg-opt` | Form fields and choices on native elements — no script | components/forms.html |
| `.card` with `.card-kicker`, `.card-title`, `.card-body`, `.card-meta`; `.elev-sm/md/lg` | Transparent, hairline-bordered cards with corner registration marks | components/cards.html |
| `.nav` + `.nav-brand` | The header bar | components/navigation.html |
| `.table` | Data tables with themed header and row rules | components/table.html |
| `.dialog-backdrop` + `.dialog` (+ `.dialog-title/-body/-actions`) | A modal at the top elevation | components/dialog.html |
| `.hr` | A horizontal rule — present, but this system prefers whitespace; avoid it | — |
| `.blueprint` + four `<i class="corner tl/tr/bl/br">` children | The wireframe frame every card, figure and primary button wears | components/cards.html |
| `.duotone` | The image wrapper — every content photograph goes through it | foundations/image.html |

States are built in: hovers and pressed states come from the accent ramp, keyboard focus is the 2px accent `:focus-visible` ring, `::selection` is an accent tint, and disabled controls drop to 45% opacity. Don't restyle them per page. The accent-to-ground pair is tuned to at least 3:1 — enough for icons, large text and interface chrome, not for body copy — so for paragraph-size text in the accent use a deep ramp step (`--color-accent-700` on this ground) rather than the accent itself.

## Do

- Frame cards, figures and primary buttons as blueprint objects: the `.blueprint` class plus four `<i class="corner …">` marks.
- Keep the grid visible — equal cells, strong horizontal and vertical rhythm.
- Condense headings (Barlow Condensed) and keep body copy in Barlow.
- Duotone photographs with the `.duotone` wrapper so they take the accent.

## Don't

- Do not round cards, figures or buttons, and do not give cards or figures a surface fill — they are line drawings (the solid accent primary button is the one deliberate exception).
- Do not drop the registration marks from a framed element.
- Do not use thick icon strokes; the set is Lucide at 1.5.
- Do not add decorative color beyond the steel accent. The accent's own deep step (`--color-accent-900`) may carry a full field where the deck's section dividers use it — steel as ground, type reversed to paper. (The landing's numbers sit on a drawn spec-sheet plate on the paper ground instead — its own grammar, not a field.)

## Files

- `styles.css` — the only stylesheet: the token sheet (`:root` variables, ramps, base type) plus the component layer. Link it from every page.
- `readme.md` — this guide.
- `theme.json` — the parameters these files were derived from (a machine-readable record of the theme).
- `thumbnail.html` — the project cover (brand mark + swatches).
- `foundations/type.html` — the type scale and the heading/body pairing at real sizes.
- `foundations/color.html` — color roles and the 100-900 tonal ramps, with usage notes.
- `foundations/layout.html` — the spacing scale, the grid and how edges are drawn.
- `foundations/icons.html` — the icon set at interface sizes, inline and in buttons.
- `foundations/image.html` — how photographs and figures are treated.
- `components/buttons.html` — buttons, icon buttons and tags in every variant and state.
- `components/forms.html` — text fields, radios and the segmented control on native elements.
- `components/cards.html` — content cards and the elevation steps.
- `components/navigation.html` — the header bar pattern.
- `components/table.html` — a data table with the themed header and row rules.
- `components/dialog.html` — a modal over its backdrop at the top elevation.
- `theme.html` — the theme's parameters rendered as a reference sheet.
- `templates/landing/` — a starter page consuming the system the intended way (`index.html`, its `ds-base.js` loader, and the vendored `image-slot.js` its photograph mounts).
- `assets/photo.jpg` — the reference photograph the imagery page treats.

---

## 이 리포에 있는 것 (2026-08-03)

**시각 규칙이 갈릴 때는 이 문서와 옆의 `styles.css`가 기준이다.** 위 `## Files` 목록은 상류
디자인 시스템 프로젝트(`Industry`) 기준이라 여기 없는 파일도 적혀 있다. 실제로 이 폴더에 있는
것은 이게 전부다.

- `styles.css` — 토큰·컴포넌트. 상류와 **한 줄 다르다**: Google Fonts `@import`를 로컬 `fonts.css`로 돌렸다
- `fonts.css` · `fonts/` — Barlow / Barlow Condensed latin 서브셋 5종. 오프라인 시연 대비
- `readme.md` — 이 문서

쇼케이스(`foundations/`·`components/`·`theme.html`)와 예제(`templates/`)는 안 가져왔다.
토큰이 실제로 어떻게 보이는지 확인할 일이 생기면 상류 프로젝트에서 그때 받으면 된다.

이 폴더가 여기 있는 이유는 `server/public/README.md`에 있다.
경보 색처럼 이 시스템에 없어서 관제용으로 따로 정한 값은 `docs/plan/impl/01_design-ui-list.md` §2.2다.
