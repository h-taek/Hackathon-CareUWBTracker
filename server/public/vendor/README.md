# vendor/ — 브라우저용 서드파티 라이브러리 (정적 동봉)

`npm install`·번들러 없이 브라우저가 바로 로드한다. 프로젝트 기조가 "런타임 의존성 0 =
클론-앤-런"이라 npm 의존성으로 넣지 않고 배포본만 여기 복사한다(plan/impl/03 결정).

`public/` 배치가 곧 URL이므로 페이지에서는 임포트 맵으로 참조한다:

```html
<script type="importmap">
{ "imports": {
    "three": "/vendor/three/three.module.min.js",
    "@mkkellogg/gaussian-splats-3d": "/vendor/gaussian-splats-3d/gaussian-splats-3d.module.js"
} }
</script>
```

`three.module.min.js`는 같은 폴더의 `three.core.min.js`를 상대경로로 임포트하므로 둘을
같이 둬야 한다. `gaussian-splats-3d.module.js`는 bare specifier `three` 하나만 임포트한다
(그래서 임포트 맵이 필수다).

## 수록 내역

| 경로 | 패키지 | 버전 | 라이선스 |
|---|---|---|---|
| `three/` | [three](https://www.npmjs.com/package/three) | 0.185.1 | MIT (`three/LICENSE`) |
| `gaussian-splats-3d/` | [@mkkellogg/gaussian-splats-3d](https://www.npmjs.com/package/@mkkellogg/gaussian-splats-3d) | 0.4.7 | MIT (`gaussian-splats-3d/LICENSE`) |

## 갱신 절차

npm 레지스트리 배포본에서 필요한 파일만 복사한다. 소스맵(`*.map`)은 용량만 크고 데모에
불필요해 제외했다.

```bash
cd "$(mktemp -d)"
npm pack three@<버전> @mkkellogg/gaussian-splats-3d@<버전>
tar xzf three-*.tgz && mv package three-pkg
tar xzf mkkellogg-*.tgz && mv package gs-pkg

DEST=<레포>/server/public/vendor
cp three-pkg/build/three.module.min.js three-pkg/build/three.core.min.js three-pkg/LICENSE "$DEST/three/"
cp gs-pkg/build/gaussian-splats-3d.module.js gs-pkg/LICENSE "$DEST/gaussian-splats-3d/"
```

갱신 후 이 표의 버전을 같이 고친다. `gaussian-splats-3d`의 three peer 범위는 `>=0.160.0`.

## 함정 — `gpuAcceleratedSort`는 켜지 마라

라이브러리 README 예제에는 `gpuAcceleratedSort: true`가 박혀 있지만 **0.4.7에서 켜면 화면이
검게 나온다.** 이 모드에서는 스플랫 좌표를 정렬 워커에 올리는 경로(`preSortMessages`)가 통째로
생략되는데, 워커는 `min(요청 렌더수, 업로드된 스플랫수)`로 그릴 개수를 정한다 — 업로드가 0이니
항상 0이 되어 `geometry.instanceCount`가 0, draw call 자체가 안 나간다. 오류도 경고도 안 나고
로드 지표(스플랫 수·로드 시간)와 FPS는 정상으로 찍히므로 원인 찾기가 고약하다.
라이브러리 기본값(`false`)을 쓴다.

**증상 구분법**: 로드는 멀쩡한데 화면만 까맣다 → 콘솔에서
`viewer.splatMesh.geometry.instanceCount`가 0이면 확정. 버전을 올릴 때 이 항목을 다시 확인한다.
