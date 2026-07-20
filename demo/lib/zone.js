'use strict';

// 맵 좌표 (x,y)가 든 첫 zone의 라벨을 반환(순수). 없으면 '미지정'.
function zoneAt(map, x, y) {
  for (const z of map.zones) {
    const [rx, ry, rw, rh] = z.rect;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return z.label;
  }
  return '미지정';
}

module.exports = { zoneAt };
