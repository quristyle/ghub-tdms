// 도형의 "모양"을 만드는 계산만 모아 둔 곳 — 원래 PDF.js에는 없다 (2026-09-02 CM 지시).
// 화면에 미리 보여줄 때와 실제로 PDF에 넣을 때가 똑같은 모양이어야 하므로, 모양을 만드는 규칙은
// 이 파일 한 곳에만 둔다(dms-shapes.js는 여기서 만든 결과를 쓰기만 한다).
//
// 좌표는 전부 화면 픽셀(왼쪽 위가 0,0이고 아래로 갈수록 y가 커진다)이다.
//
// 도형 하나는 "선 묶음(subpath)" 여러 개로 이뤄진다(화살표는 몸통 + 머리 둘, 글자는 획마다 하나).
// 묶음 하나는 셋을 갖는다.
//   start  : 시작점
//   segs   : 베지어 명령 [제어점1x,제어점1y, 제어점2x,제어점2y, 끝점x,끝점y] — 곧은 선도 베지어로 적는다.
//            PDF.js가 화면과 저장 파일 둘 다 이 값으로 그리기 때문에, 곧은 선을 곧게 그리려면
//            제어점을 그 선 위(1/3·2/3 지점)에 놓아야 한다. 안 그러면 사각형 모서리가 둥글어진다.
//   points : PDF 표준 잉크 주석의 꼭짓점 목록(다른 프로그램이 참고로 읽는 값)

const KAPPA = 0.5522847498; // 원을 베지어 곡선 4개로 그릴 때 쓰는 값

// ---------------------------------------------------------------- 선 묶음 만들기

export function straightSubpath(pts) {
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    segs.push([
      x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3,
      x0 + (x1 - x0) * 2 / 3, y0 + (y1 - y0) * 2 / 3,
      x1, y1,
    ]);
  }
  return { start: pts[0], segs, points: pts };
}

function ellipsePoints(cx, cy, rx, ry, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

function ellipseSubpath(x0, y0, x1, y1) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const segs = [
    [cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    [cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    [cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    [cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
  ];
  return { start: [cx + rx, cy], segs, points: ellipsePoints(cx, cy, rx, ry, 48) };
}

// 각도 a0~a1(도) 사이의 타원 조각을 점으로 만든다. 화면 좌표라 y는 아래쪽이 커지는 쪽이다.
function arcPoints(cx, cy, rx, ry, a0, a1, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

// ------------------------------------------------------------------- 글자 도형
// LOTO·CLOSE·OPEN은 글자처럼 보이지만 도형으로 다룬다(CM 확정). 글꼴을 쓰면 도형이 아니라
// 글자 주석이 되어 색·두께·회전을 다른 도형과 똑같이 다룰 수 없으므로, 획을 직접 그어 만든다.
// 아래 값은 가로 1 · 세로 1짜리 네모 안에서의 자리다(왼쪽 위가 0,0).

const LETTERS = {
  L: () => [[[0, 0], [0, 1], [0.85, 1]]],
  T: () => [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]],
  E: () => [[[1, 0], [0, 0], [0, 1], [1, 1]], [[0, 0.5], [0.72, 0.5]]],
  N: () => [[[0, 1], [0, 0], [1, 1], [1, 0]]],
  O: () => [ellipsePoints(0.5, 0.5, 0.5, 0.5, 32)],
  // C — 오른쪽이 열린 타원 조각
  C: () => [arcPoints(0.5, 0.5, 0.5, 0.5, 35, 325)],
  // S — 위 사발과 아래 사발을 한가운데에서 잇는다
  S: () => [[
    ...arcPoints(0.5, 0.26, 0.48, 0.26, 0, -270, 20),
    ...arcPoints(0.5, 0.74, 0.48, 0.26, 270, 540, 20),
  ]],
  // B — 세로 획 + 위아래 두 사발
  B: () => [
    [[0, 0], [0, 1]],
    [[0, 0], ...arcPoints(0.24, 0.26, 0.46, 0.26, -90, 90, 14), [0, 0.52]],
    [[0, 0.52], ...arcPoints(0.24, 0.76, 0.5, 0.24, -90, 90, 14), [0, 1]],
  ],
  // I — 가운데 세로 획 하나
  I: () => [[[0.5, 0], [0.5, 1]]],
  // D — 세로 획 + 오른쪽 반원
  D: () => [
    [[0, 0], [0, 1]],
    [[0, 0], ...arcPoints(0.16, 0.5, 0.62, 0.5, -90, 90, 20), [0, 1]],
  ],
  // P — 세로 획 + 위쪽 반원 사발
  P: () => [
    [[0, 0], [0, 1]],
    [[0, 0], ...arcPoints(0.28, 0.27, 0.5, 0.27, -90, 90, 16), [0, 0.54]],
  ],
};

// 위 값들은 가로세로 1:1 네모에 그린 것이라 그대로 쓰면 글자가 너무 넓적하다.
// 실제 글자꼴처럼 보이도록 가로를 줄여 놓는다(세로를 1로 봤을 때의 가로 길이·글자 사이 간격).
const LETTER_W = 0.62;
const LETTER_GAP = 0.16;

// 글자 도형에서 글자 둘레에 두는 여백 — 칠하는 네모는 글자에서 이만큼 바깥이다
// (2026-09-05 CM 지시). 글자 높이에 견준 값이라 크게 그리든 작게 그리든 같은 비율로 보인다.
// 여기에 선 굵기의 절반을 더해, 굵게 그려도 글자가 칠한 자리를 넘지 않는다.
// 값을 작게 잡은 이유: 자료를 골랐을 때 나오는 네모(선택 상자)는 글자에 딱 맞게 그려지는데,
// 칠한 자리가 그보다 많이 커 보이면 안 되기 때문이다.
const TEXT_SHAPE_PAD = 0.06;

function textPolylines(text, x0, y0, x1, y1) {
  const chars = [...String(text).toUpperCase()].filter((c) => LETTERS[c]);
  if (chars.length === 0) return [];
  const unitWidth = chars.length * LETTER_W + LETTER_GAP * (chars.length - 1);
  const boxW = Math.abs(x1 - x0);
  const boxH = Math.abs(y1 - y0);
  // 글자가 찌그러지지 않도록 가로·세로를 같은 비율로 줄여 네모 안에 담고 가운데에 놓는다.
  const scale = Math.min(boxW / unitWidth, boxH);
  const left = Math.min(x0, x1) + (boxW - unitWidth * scale) / 2;
  const top = Math.min(y0, y1) + (boxH - scale) / 2;

  const out = [];
  chars.forEach((char, index) => {
    const offset = left + index * (LETTER_W + LETTER_GAP) * scale;
    for (const stroke of LETTERS[char]()) {
      out.push(stroke.map(([x, y]) => [offset + x * LETTER_W * scale, top + y * scale]));
    }
  });
  return out;
}

// ------------------------------------------------------------------- 화살표 머리

function arrowHeadPoints(x0, y0, x1, y1, thickness) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const length = Math.hypot(x1 - x0, y1 - y0);
  const size = Math.min(Math.max(thickness * 4, 10), length / 2 || 10);
  const wing = (a) => [x1 - size * Math.cos(a), y1 - size * Math.sin(a)];
  return [wing(angle - Math.PI / 6), [x1, y1], wing(angle + Math.PI / 6)];
}

// ----------------------------------------------------------------------- 회전

function rotatePoint([x, y], cx, cy, cos, sin) {
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function rotateSubpath(sub, cx, cy, cos, sin) {
  const segs = sub.segs.map((g) => {
    const c1 = rotatePoint([g[0], g[1]], cx, cy, cos, sin);
    const c2 = rotatePoint([g[2], g[3]], cx, cy, cos, sin);
    const end = rotatePoint([g[4], g[5]], cx, cy, cos, sin);
    return [c1[0], c1[1], c2[0], c2[1], end[0], end[1]];
  });
  return {
    start: rotatePoint(sub.start, cx, cy, cos, sin),
    segs,
    points: sub.points.map((p) => rotatePoint(p, cx, cy, cos, sin)),
  };
}

// ------------------------------------------------- 한쪽으로 볼록한 호 (구름 조각)
//
// 두 점 사이를 반원처럼 부풀린 곡선 하나로 잇는다. 구름 도형과 "구름" 선 타입이 함께 쓴다.
// 제어점을 선 길이의 2/3만큼 옆으로 밀면 가운데가 정확히 반지름(길이의 절반)만큼 부풀어
// 올라 반원과 거의 같은 모양이 된다.
//   side : 부풀어 오를 쪽 (+1 = 진행 방향의 왼쪽, -1 = 오른쪽. 화면 좌표라 y는 아래가 크다)

function bulgeControls(p0, p1, side) {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const h = (len * 2) / 3;
  const nx = (-dy / len) * side * h;
  const ny = (dx / len) * side * h;
  return [[p0[0] + nx, p0[1] + ny], [p1[0] + nx, p1[1] + ny]];
}

/** 베지어 곡선 위의 점들 (PDF 표준 잉크 주석이 참고로 읽는 꼭짓점 목록에 쓴다) */
function bezierPoints(p0, c1, c2, p1, steps) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return pts;
}

/** 이음점들을 한쪽으로 볼록한 호로 이어 붙인 선 묶음 (구름 모양) */
function scallopSubpath(knots, side) {
  const segs = [];
  const points = [knots[0]];
  for (let i = 1; i < knots.length; i++) {
    const ctrl = bulgeControls(knots[i - 1], knots[i], side);
    if (!ctrl) continue;
    segs.push([ctrl[0][0], ctrl[0][1], ctrl[1][0], ctrl[1][1], knots[i][0], knots[i][1]]);
    points.push(...bezierPoints(knots[i - 1], ctrl[0], ctrl[1], knots[i], 6));
  }
  return segs.length ? { start: knots[0], segs, points } : null;
}

// --------------------------------------------------------------- 별 · 폭발 · 구름
// (2026-09-04 CM 지시. CM이 준 그림을 참고하되 개념만 가져왔다.)

const STAR_TIPS = 5;
const STAR_INNER = 0.382; // 정오각별의 안쪽 반지름 비율

// 폭발 — 뾰족한 조각 12개. 바깥 반지름을 조금씩 다르게 해 터지는 느낌을 낸다.
// 언제 그려도 같은 모양이 되도록 값을 적어 둔다(그때그때 흔들면 그린 뒤에 모양이 달라진다).
const BURST_OUTER = [1, 0.84, 0.97, 0.88, 1, 0.82, 0.95, 0.9, 1, 0.86, 0.96, 0.88];
const BURST_INNER = 0.5;

const CLOUD_BUMPS = 11; // 구름 도형의 둘레를 몇 조각으로 나눠 호를 그릴지

/** 가운데에서 각도·반지름 비율로 잰 꼭짓점 하나 */
function radialPoint(cx, cy, rx, ry, degree, ratio) {
  const a = (degree * Math.PI) / 180;
  return [cx + rx * ratio * Math.cos(a), cy + ry * ratio * Math.sin(a)];
}

function centerOf(x0, y0, x1, y1) {
  return {
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    rx: Math.abs(x1 - x0) / 2, ry: Math.abs(y1 - y0) / 2,
  };
}

/** 별 — 꼭짓점이 위를 향한 오각별 */
function starPolygon(x0, y0, x1, y1) {
  const { cx, cy, rx, ry } = centerOf(x0, y0, x1, y1);
  const pts = [];
  for (let i = 0; i < STAR_TIPS * 2; i++) {
    pts.push(radialPoint(cx, cy, rx, ry, -90 + (180 / STAR_TIPS) * i, i % 2 === 0 ? 1 : STAR_INNER));
  }
  pts.push(pts[0]);
  return pts;
}

/** 폭발 — 뾰족한 조각이 빙 둘러 있는 모양 */
function burstPolygon(x0, y0, x1, y1) {
  const { cx, cy, rx, ry } = centerOf(x0, y0, x1, y1);
  const n = BURST_OUTER.length;
  const step = 360 / n;
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push(radialPoint(cx, cy, rx, ry, -90 + step * i, BURST_OUTER[i]));
    pts.push(radialPoint(cx, cy, rx, ry, -90 + step * (i + 0.5), BURST_INNER));
  }
  pts.push(pts[0]);
  return pts;
}

/** 선 묶음 하나를 실제 크기대로 재서 정해진 네모에 딱 맞게 늘리거나 줄인다 */
function fitSubpathToBox(sub, x0, y0, x1, y1) {
  const box = boundingBox(sub.points);
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  if (width < 1e-6 || height < 1e-6) return sub;
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const sx = Math.abs(x1 - x0) / width;
  const sy = Math.abs(y1 - y0) / height;
  const at = ([x, y]) => [left + (x - box[0]) * sx, top + (y - box[1]) * sy];
  return {
    start: at(sub.start),
    segs: sub.segs.map((g) => [...at([g[0], g[1]]), ...at([g[2], g[3]]), ...at([g[4], g[5]])]),
    points: sub.points.map(at),
  };
}

/** 구름 — 타원 둘레를 따라 바깥으로 볼록한 호를 빙 둘러 그린다 */
function cloudSubpath(x0, y0, x1, y1) {
  const { cx, cy, rx, ry } = centerOf(x0, y0, x1, y1);
  const knots = [];
  for (let i = 0; i <= CLOUD_BUMPS; i++) {
    knots.push(radialPoint(cx, cy, rx, ry, -90 + (360 / CLOUD_BUMPS) * i, 1));
  }
  // 각도가 커지는 쪽으로 돌면 화면에서는 시계방향이므로, 바깥은 오른쪽(-1)이다.
  const sub = scallopSubpath(knots, -1);
  // 호가 바깥으로 부풀어 오른 만큼 넘치므로, 다 만든 뒤 실제 크기를 재서 네모에 맞춘다
  // (얼마나 부푸는지는 가로세로 비율에 따라 달라서 미리 계산해 줄이는 것으로는 안 맞는다).
  return sub && fitSubpathToBox(sub, x0, y0, x1, y1);
}

// ------------------------------------------------------------------ 도형 만들기

// 내부를 색으로 채울 수 있는 모양(닫힌 도형)
// 밸브는 2026-09-18부터 [채움 전환]으로 칠하므로 여기서 빠졌다(아래 TOGGLE_SHAPES).
export const CLOSED_SHAPES = new Set([
  "rect", "ellipse", "triangle", "star", "burst", "cloud",
]);

// 글자 도형 — 여기 없는 이름은 위 SHAPES 목록의 도형이다
export const TEXT_SHAPES = new Set(["LOTO", "CLOSE", "OPEN", "BLIND", "CSO", "CSC"]);

// 칠했다 비웠다 하는 도형 (2026-09-04 CM 지시, 밸브는 2026-09-18 CM 지시로 추가).
// 이 셋은 [도형 채우기]를 쓰지 않고, 그려 놓은 뒤 그 옆 작은 도구모음의 [채움 전환]으로 바꾼다.
//   블라인드      : 동그라미 하나 — 비움(흰색) ↔ 채움(선 색)
//   스펙타클 블라인드 : 동그라미 둘 — 위 채움 ↔ 아래 채움 (안 채운 쪽은 흰색)
//   밸브          : 세모 둘 — 비움(흰색) ↔ 채움(선 색). 도면에서 속이 찬 밸브는 "닫힘"을 뜻한다.
// 칠할 자리는 buildShape이 regions로 돌려주고, 어느 쪽을 무슨 색으로 칠할지는 dms-shapes.js가 정한다.
export const TOGGLE_SHAPES = new Set(["blind", "spectacle", "bowtie"]);

/**
 * 사용자가 [도형 채우기]로 안을 칠할 수 있는 모양인지.
 * 글자 도형도 칠할 수 있다 — 글자를 뺀 네모 안이 칠해진다(2026-09-04 CM 지시).
 * 블라인드·스펙타클 블라인드·밸브는 [채움 전환]이 따로 있으므로 여기서 빠진다.
 */
export function canFill(kind) {
  return CLOSED_SHAPES.has(kind) || TEXT_SHAPES.has(kind);
}

/**
 * 도형 하나를 만든다.
 *   kind      : rect | ellipse | triangle | bowtie | blind | star | burst | cloud
 *               | line | arrow | dim(치수선) | 글자 도형(LOTO 등)
 *   box       : {x0,y0,x1,y1} 끌어서 정한 네모 (화면 픽셀)
 *   thickness : 선 굵기 (화면 픽셀)
 *   angle     : 회전 각도(도). 네모의 한가운데를 기준으로 돌린다.
 * 돌려주는 것: { subpaths, outline, regions }
 *   outline은 색을 채울 때 쓰는 닫힌 다각형이고, 채울 수 없는 모양이면 null이다.
 *   regions는 블라인드·스펙타클 블라인드의 동그라미들과 밸브의 세모 둘 — [채움 전환]이 이 자리를 칠한다.
 */
export function buildShape(kind, { x0, y0, x1, y1 }, thickness, angle = 0) {
  let subpaths;
  let outline = null;
  let regions = null;

  switch (kind) {
    case "ellipse": {
      const sub = ellipseSubpath(x0, y0, x1, y1);
      subpaths = [sub];
      outline = sub.points;
      break;
    }
    case "triangle": {
      const pts = [[(x0 + x1) / 2, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, y0]];
      subpaths = [straightSubpath(pts)];
      outline = pts;
      break;
    }
    case "line":
      subpaths = [straightSubpath([[x0, y0], [x1, y1]])];
      break;
    case "arrow":
      subpaths = [
        straightSubpath([[x0, y0], [x1, y1]]),
        straightSubpath(arrowHeadPoints(x0, y0, x1, y1, thickness)),
      ];
      break;
    case "rect": {
      const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      subpaths = [straightSubpath(pts)];
      outline = pts;
      break;
    }
    // 밸브 — 세모 둘이 꿉지점에서 만나는 나비넥타이 모양 (2026-09-02 CM 지시)
    case "bowtie": {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      // 왼쪽 세모(왼쪽 변 + 꿉지점)과 오른쪽 세모를 한 번에 둘러 그린다.
      const pts = [[x0, y0], [cx, cy], [x1, y0], [x1, y1], [cx, cy], [x0, y1], [x0, y0]];
      subpaths = [straightSubpath(pts)];
      outline = pts;
      // [채움 전환]이 칠하는 자리 — 세모 둘을 한 번에 칠한다(가운데 잘록한 곳은 칠하는 규칙이 비워 둔다).
      regions = [pts];
      break;
    }
    // 블라인드 — 위에 동그라미가 있고 아래로 자루가 내려오는 모양 (2026-09-03 CM 지시).
    // 동그라미 안은 [채움 전환]으로 칠했다 비웠다 한다(자루는 선이라 채울 면이 없다).
    case "blind": {
      const cx = (x0 + x1) / 2;
      const top = Math.min(y0, y1);
      const bottom = Math.max(y0, y1);
      // 동그라미는 자루가 들어갈 자리를 남기고 위쪽에 놓되, 끌어 놓은 너비보다 커지지 않게 한다.
      const d = Math.min(Math.abs(x1 - x0), (bottom - top) * 0.45);
      const r = d / 2;
      const circle = ellipseSubpath(cx - r, top, cx + r, top + d);
      subpaths = [circle, straightSubpath([[cx, top + d], [cx, bottom]])];
      regions = [circle.points];
      break;
    }
    // 스펙타클 블라인드 — 동그라미 둘이 위아래로 붙어 있고 그 밑으로 자루가 내려오는 모양
    // (2026-09-04 CM 지시, CM이 준 그림 그대로). 블라인드에 동그라미가 하나 더 붙은 것이다.
    // 처음에는 위 동그라미가 선 색으로 칠해져 있고, [채움 전환]을 누르면 아래 동그라미가 칠해진다.
    case "spectacle": {
      const cx = (x0 + x1) / 2;
      const top = Math.min(y0, y1);
      const bottom = Math.max(y0, y1);
      // 동그라미 둘이 세로로 들어가야 하므로 블라인드보다 작게 잡는다.
      const d = Math.min(Math.abs(x1 - x0), (bottom - top) * 0.35);
      const r = d / 2;
      const upper = ellipseSubpath(cx - r, top, cx + r, top + d);
      const lower = ellipseSubpath(cx - r, top + d, cx + r, top + d * 2);
      subpaths = [upper, lower, straightSubpath([[cx, top + d * 2], [cx, bottom]])];
      regions = [upper.points, lower.points];
      break;
    }
    // 치수선 — 양쪽 끝에 화살표가 달린 선 (2026-09-04 CM 지시)
    case "dim":
      subpaths = [
        straightSubpath([[x0, y0], [x1, y1]]),
        straightSubpath(arrowHeadPoints(x0, y0, x1, y1, thickness)),
        straightSubpath(arrowHeadPoints(x1, y1, x0, y0, thickness)),
      ];
      break;
    case "star": {
      const pts = starPolygon(x0, y0, x1, y1);
      subpaths = [straightSubpath(pts)];
      outline = pts;
      break;
    }
    case "burst": {
      const pts = burstPolygon(x0, y0, x1, y1);
      subpaths = [straightSubpath(pts)];
      outline = pts;
      break;
    }
    case "cloud": {
      const sub = cloudSubpath(x0, y0, x1, y1);
      subpaths = sub ? [sub] : [];
      outline = sub ? sub.points : null;
      break;
    }
    default: { // LOTO·CLOSE·OPEN·BLIND·CSO·CSC 같은 글자 도형
      const lines = textPolylines(kind, x0, y0, x1, y1);
      subpaths = lines.map(straightSubpath);
      // 칠하는 네모는 **글자를 감싸는 자리**다 (2026-09-05 CM 지시) — 끌어 놓은 네모가 아니다.
      // 글자는 찌그러지지 않게 가로세로 비율을 지켜 그려지므로, 넓게 끌면 글자가 가운데에만
      // 놓이고 양옆이 비는데, 예전에는 그 빈 자리까지 칠해져 글자를 고를 때 나오는 네모
      // (선택 상자)보다 칠한 자리가 훨씬 컸다. 이제 둘이 같아진다.
      // 선 굵기의 절반이 글자 밖으로 나가므로 그만큼과 여백을 더해 감싼다.
      const box = boundingBox(lines.flat());
      if (Number.isFinite(box[0])) {
        const pad = (box[3] - box[1]) * TEXT_SHAPE_PAD + thickness / 2;
        outline = [
          [box[0] - pad, box[1] - pad], [box[2] + pad, box[1] - pad],
          [box[2] + pad, box[3] + pad], [box[0] - pad, box[3] + pad],
          [box[0] - pad, box[1] - pad],
        ];
      }
      break;
    }
  }

  if (angle % 360 !== 0) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const turn = (pts) => pts.map((p) => rotatePoint(p, cx, cy, cos, sin));
    subpaths = subpaths.map((sub) => rotateSubpath(sub, cx, cy, cos, sin));
    if (outline) outline = turn(outline);
    if (regions) regions = regions.map(turn);
  }
  return { subpaths, outline, regions };
}

/** 미리보기(SVG)에 그릴 경로 문자열 */
export function toSvgPath(subpaths) {
  return subpaths
    .map(({ start, segs }) =>
      "M" + start[0] + " " + start[1] +
      segs.map((g) => "C" + g[0] + " " + g[1] + " " + g[2] + " " + g[3] + " " + g[4] + " " + g[5]).join(""))
    .join(" ");
}

// --------------------------------------------------------- Shift 눌렀을 때 맞추기

const SNAP_STEP = 15; // 도형 도구의 직선·화살표는 15도 단위로 꺾인다 (PPT와 같다)

/**
 * Shift를 누르고 그릴 때 끝점을 반듯하게 맞춘다.
 *   mode "axis" : 수직·수평만 (강조표시·그리기의 Shift — 2026-09-02 CM 지시)
 *   mode "step" : 도형 도구의 기존 규칙 — 직선·화살표·치수선은 15도 단위,
 *                 네모·타원·삼각형·밸브·글자는 가로세로가 같은 정도형
 */
export function snapEnd(kind, x0, y0, x1, y1, mode = "step") {
  if (mode === "axis") {
    // 더 많이 움직인 쪽으로 누워 수평선 또는 수직선을 만든다.
    return Math.abs(x1 - x0) >= Math.abs(y1 - y0) ? [x1, y0] : [x0, y1];
  }
  if (kind === "line" || kind === "arrow" || kind === "dim") {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const step = (SNAP_STEP * Math.PI) / 180;
    const angle = Math.round(Math.atan2(y1 - y0, x1 - x0) / step) * step;
    return [x0 + length * Math.cos(angle), y0 + length * Math.sin(angle)];
  }
  const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  return [x0 + Math.sign(x1 - x0 || 1) * size, y0 + Math.sign(y1 - y0 || 1) * size];
}

// -------------------------------------------------------------------- 선 타입
//
// 그리기(펜) 도구창에서 고르는 선 모양이다 (2026-09-04 CM 지시).
//   실선      : 손대지 않는다 (PDF.js가 그리던 그대로)
//   점선·파선 : 그은 선을 짧은 조각들로 끊어 만든다
//   구름      : 그은 선을 따라 한쪽으로 볼록한 호를 이어 그린다
//               — 도면이 고쳐진 자리에 두르는 Revision 표시용(CM 설명)
//
// 점선·파선을 "정말로 끊어서" 만드는 이유: PDF.js가 쓰는 그리기(잉크) 주석에는 점선이라는
// 값이 아예 없다. 화면에서만 점선처럼 보이게 하면 저장한 PDF에서는 실선으로 나오므로,
// 조각난 선으로 만들어 넣는다. 그래야 다른 PDF 프로그램에서 열어도 점선으로 보인다.

export const LINE_TYPES = [
  { id: "solid", label: "실선" },
  { id: "dotted", label: "점선" },
  { id: "dashed", label: "파선" },
  { id: "cloud", label: "구름" },
];

// [선 굵기의 몇 배, 아무리 가늘어도 이보다는 길게] — 화면 픽셀
const DASH_RULES = {
  dotted: { on: [1.4, 1.6], off: [2.2, 3] },
  dashed: { on: [4.5, 9], off: [3, 5] },
};
const CLOUD_BUMP = [10, 20]; // 구름 선의 호 하나 길이
const MAX_PIECES = 400;     // 조각이 이보다 많아지면 간격을 늘린다(너무 잘면 무거워진다)

const sizeOf = ([times, least], thickness) => Math.max(least, thickness * times);

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/** 점 목록을 따라 "그리고(on) 띄고(off)"를 되풀이하며 조각들로 자른다 */
function dashPolylines(points, on, off) {
  const out = [];
  let piece = [points[0]];
  let drawing = true;
  let remain = on;
  let prev = points[0];

  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    let left = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    while (left >= remain) {
      const t = remain / left;
      const cut = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      if (drawing) {
        piece.push(cut);
        out.push(piece);
        piece = [];
      } else {
        piece = [cut];
      }
      drawing = !drawing;
      remain = drawing ? on : off;
      prev = cut;
      left = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]); // 잘린 자리부터 남은 거리
    }
    remain -= left;
    if (drawing) piece.push(cur);
    prev = cur;
  }
  if (drawing && piece.length > 1) out.push(piece);
  return out;
}

/** 점 목록을 균등한 간격의 이음점으로 다시 잡는다 (구름 호가 이어지는 자리) */
function resamplePath(points, step) {
  const total = pathLength(points);
  if (total < 1e-6) return null;
  const count = Math.max(2, Math.round(total / step));
  const gap = total / count;
  const knots = [points[0]];
  let target = gap;
  let walked = 0;

  for (let i = 1; i < points.length; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const len = Math.hypot(cx - px, cy - py);
    if (len < 1e-9) continue;
    while (walked + len >= target - 1e-9 && knots.length <= count) {
      const t = (target - walked) / len;
      knots.push([px + (cx - px) * t, py + (cy - py) * t]);
      target += gap;
    }
    walked += len;
  }
  if (knots.length <= count) knots.push(points[points.length - 1]);
  return knots;
}

const isClosedPath = (points) => {
  const a = points[0];
  const b = points[points.length - 1];
  return Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6;
};

/** 구름 호가 부풀 쪽 — 닫힌 도형이면 바깥, 열린 선이면 진행 방향의 오른쪽 */
function bulgeSide(points) {
  if (!isClosedPath(points)) return -1;
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    area += points[i - 1][0] * points[i][1] - points[i][0] * points[i - 1][1];
  }
  return area > 0 ? -1 : 1; // 화면 좌표에서 시계방향(area>0)이면 바깥은 오른쪽이다
}

/**
 * 선 묶음을 고른 선 타입의 모양으로 바꾼다.
 * 화면 픽셀 좌표에서 계산하므로 thickness도 화면 기준 굵기를 넘겨야 간격이 맞는다.
 * 채우기용 outline은 원래 모양 그대로 두므로(칠은 끊기면 안 된다) 여기서 다루지 않는다.
 */
export function applyLineType(subpaths, lineType, thickness) {
  if (!lineType || lineType === "solid") return subpaths;
  const out = [];

  for (const sub of subpaths) {
    const points = sub.points;
    if (!points || points.length < 2) {
      out.push(sub);
      continue;
    }
    if (lineType === "cloud") {
      const knots = resamplePath(points, sizeOf(CLOUD_BUMP, thickness));
      out.push((knots && scallopSubpath(knots, bulgeSide(points))) || sub);
      continue;
    }
    const rule = DASH_RULES[lineType];
    if (!rule) {
      out.push(sub);
      continue;
    }
    let on = sizeOf(rule.on, thickness);
    let off = sizeOf(rule.off, thickness);
    const pieces = pathLength(points) / (on + off);
    if (pieces > MAX_PIECES) {
      const grow = pieces / MAX_PIECES;
      on *= grow;
      off *= grow;
    }
    for (const piece of dashPolylines(points, on, off)) {
      if (piece.length >= 2) out.push(straightSubpath(piece));
    }
  }
  return out.length ? out : subpaths;
}

// ------------------------------------------------------ 색 채우기용 네모 만들기
//
// PDF 주석 하나에는 색을 하나만 넣을 수 있어서, PDF.js는 "선 색"과 "채우기 색"을 한 주석에
// 같이 저장하지 못한다. 그래서 채움은 형광펜과 같은 방식(넓게 칠하는 주석)으로 따로 만든다.
// 형광펜이 여러 줄에 걸친 글을 칠할 때 쓰는 방식이 "네모 여러 개를 하나로 합쳐 칠하기"이므로,
// 도형 안을 가로로 얇게 썬 네모들로 만들어 주면 그것들이 하나의 면으로 합쳐져 칠해진다.
// (선 하나로 지그재그를 그려 칠하는 방법은 PDF.js가 합쳐주지 못해 낙서처럼 보인다 — 확인함.)

/** 다각형을 가로선 y로 잘랐을 때 만나는 x값들 */
function crossingsAt(polygon, y) {
  const xs = [];
  for (let i = 0; i < polygon.length - 1; i++) {
    const [xa, ya] = polygon[i];
    const [xb, yb] = polygon[i + 1];
    if ((ya <= y && yb > y) || (yb <= y && ya > y)) {
      xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
    }
  }
  return xs;
}

const FILL_SLICES = 150; // 도형 하나를 몇 줄로 썰지 (많을수록 가장자리가 매끈하다)
const FILL_MIN_STEP = 0.4;

/**
 * 닫힌 다각형 안을 칠하기 위한 네모 목록을 만든다.
 *   polygon : 닫힌 다각형 (마지막 점 = 첫 점), PDF 좌표
 * 돌려주는 것: PDF 표준 형광펜 주석이 쓰는 QuadPoints 값 8개씩 이어 붙인 배열
 *   (네모 하나 = [왼쪽,위, 오른쪽,위, 왼쪽,아래, 오른쪽,아래])
 */
export function fillBoxes(polygon, insetX = 0, insetY = 0) {
  const ys = polygon.map((p) => p[1]);
  // 위·아래·좌·우를 inset만큼 안으로 줄여서 칠한다. PDF.js가 채움 주석을 그릴 때 테두리를
  // 조금 바깥으로 넓히기 때문에(dms-fill.js 설명), 그만큼 미리 줄여야 채움이 윤곽선 밖으로
  // 삐져나오지 않고 안에 딱 맞는다 (2026-09-04 CM 지시).
  const minY = Math.min(...ys) + insetY;
  const maxY = Math.max(...ys) - insetY;
  if (maxY <= minY) return [];
  const step = Math.max(FILL_MIN_STEP, (maxY - minY) / FILL_SLICES);

  const quads = [];
  for (let bottom = minY; bottom < maxY - 1e-6; bottom += step) {
    const top = Math.min(bottom + step, maxY);
    const xs = crossingsAt(polygon, (bottom + top) / 2); // 줄의 한가운데에서 잰다
    if (xs.length < 2) continue;
    // 만난 자리를 왼쪽부터 둘씩 묶어 그 사이만 칠한다. 네모·타원처럼 안이 통째로 뚫린
    // 모양은 만나는 자리가 둘이라 예전과 결과가 같고, 밸브(나비넥타이)처럼 허리가 잘록한
    // 모양은 넷이라 가운데 빈 곳이 칠해지지 않는다.
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const left = xs[i] + insetX;
      const right = xs[i + 1] - insetX;
      if (right - left < 1e-6) continue;
      quads.push(left, top, right, top, left, bottom, right, bottom);
    }
  }
  return quads;
}

// --------------------------------------------------- 형광펜 띠(곧은 선·한붓그리기)
//
// 형광펜으로 그은 곧은 선은 "네모 여러 개를 한 면으로 합치기"로 만든다 — 그래야 꺾이는 자리가
// 곡선이 아니라 딱 직각(마이터)이 된다 (2026-09-04 CM 지시). PDF.js가 점 목록으로 만드는 띠는
// 꺾이는 자리를 부드럽게 다듬어 버리고, 다듬는 정도가 PDF.js 안쪽 값에 매여 있어 없앨 수 없다.
//
// 만드는 차례는 둘이다.
//   ① bandPolygons — 획을 "선마다 네모 하나 + 꺾이는 자리마다 모서리 조각"으로 쪼갠다
//   ② unionQuads   — 그 조각들을 가로로 썰어 **겹치지 않는** 네모 목록으로 합친다
// 겹치지 않게 만드는 이유: 저장한 PDF를 다른 프로그램에서 열면 네모마다 따로 칠하므로,
// 겹친 자리가 두 번 칠해져 그 부분만 진해 보이기 때문이다.

const MITER_LIMIT = 6; // 너무 뾰족하면 끝을 잘라낸다(그래도 각져 보인다). SVG 기본값과 같은 성격

const along = ([x, y], [dx, dy], d) => [x + dx * d, y + dy * d];

/** 선 하나를 감싸는 네모(닫힌 다각형) */
function segmentRect(a, b, [nx, ny], half) {
  const p0 = [a[0] + nx * half, a[1] + ny * half];
  const p1 = [b[0] + nx * half, b[1] + ny * half];
  const p2 = [b[0] - nx * half, b[1] - ny * half];
  const p3 = [a[0] - nx * half, a[1] - ny * half];
  return [p0, p1, p2, p3, p0];
}

/** 두 직선의 만나는 점 (평행이면 null) */
function lineCross(p1, d1, p2, d2) {
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / denom;
  return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

/**
 * 획(점 목록)을 감싸는 띠를 볼록한 조각 여러 개로 만든다.
 *   half            : 띠 반 두께 (PDF 단위)
 *   insetX / insetY : PDF.js가 칠할 때 테두리를 바깥으로 넓히는 만큼 미리 줄일 값
 *                     (선이 놓인 방향에 따라 줄여야 할 양이 다르므로 선마다 따로 계산한다)
 */
export function bandPolygons(pts, half, insetX = 0, insetY = 0) {
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue; // 같은 자리에 찍힌 점은 선이 아니다
    const d = [dx / len, dy / len];
    segs.push({ a: pts[i - 1], b: pts[i], d, n: [-d[1], d[0]], len });
  }
  if (segs.length === 0) return [];

  const halfOf = (n) => Math.max(0.1, half - Math.abs(n[0]) * insetX - Math.abs(n[1]) * insetY);
  const polys = [];

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    // 획의 양 끝만 줄여 넣는다 — 가운데 이음매는 맞물려야 하므로 그대로 둔다.
    const cap = Math.abs(s.d[0]) * insetX + Math.abs(s.d[1]) * insetY;
    const a = i === 0 ? along(s.a, s.d, Math.min(cap, s.len / 2)) : s.a;
    const b = i === segs.length - 1 ? along(s.b, s.d, -Math.min(cap, s.len / 2)) : s.b;
    polys.push(segmentRect(a, b, s.n, halfOf(s.n)));
  }

  // 꺾이는 자리 — 두 네모 사이에 남는 모서리를 채운다(양쪽 다 채우되, 안쪽은 이미 겹쳐 있다).
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1];
    const next = segs[i];
    const v = next.a;
    const h1 = halfOf(prev.n);
    const h2 = halfOf(next.n);
    for (const side of [1, -1]) {
      const p1 = [v[0] + prev.n[0] * h1 * side, v[1] + prev.n[1] * h1 * side];
      const p2 = [v[0] + next.n[0] * h2 * side, v[1] + next.n[1] * h2 * side];
      const m = lineCross(p1, prev.d, p2, next.d);
      const tooSharp = m && Math.hypot(m[0] - v[0], m[1] - v[1]) > Math.max(h1, h2) * MITER_LIMIT;
      // 마이터 점까지 채우면 모서리가 뾰족하게 각지고, 너무 뾰족하면 끝을 잘라 낸다.
      polys.push(m && !tooSharp ? [v, p1, m, p2, v] : [v, p1, p2, v]);
    }
  }
  return polys;
}

/**
 * 다각형 여러 개의 합집합을 **겹치지 않는** 네모 목록으로 만든다.
 *   rowStep : 가로로 써는 간격. 0이면 다각형들의 y 좌표에서만 자른다 —
 *             가로·세로 선만으로 이뤄진 모양은 이게 정확하고 네모 수도 몇 개로 끝난다.
 *             비스듬한 선이 섞이면 이 간격만큼 계단이 지므로 잘게 썬다(어긋남은 간격의 절반 이하).
 * 돌려주는 것: PDF 표준 형광펜 주석이 쓰는 QuadPoints 값 8개씩 이어 붙인 배열
 */
export function unionQuads(polygons, rowStep = 0) {
  const ys = [];
  for (const poly of polygons) for (const p of poly) ys.push(p[1]);
  if (ys.length === 0) return [];
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxY - minY < 1e-6) return [];

  const bounds = [];
  if (rowStep > 0) {
    for (let y = minY; y < maxY - 1e-9; y += rowStep) bounds.push(y);
    bounds.push(maxY);
  } else {
    const seen = new Set();
    for (const y of ys) {
      const key = Math.round(y * 1e4);
      if (!seen.has(key)) { seen.add(key); bounds.push(y); }
    }
    bounds.sort((a, b) => a - b);
  }

  const quads = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const bottom = bounds[i];
    const top = bounds[i + 1];
    if (top - bottom < 1e-6) continue;
    const mid = (bottom + top) / 2;

    const spans = [];
    for (const poly of polygons) {
      const xs = crossingsAt(poly, mid);
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        if (xs[k + 1] - xs[k] > 1e-6) spans.push([xs[k], xs[k + 1]]);
      }
    }
    if (spans.length === 0) continue;

    // 겹치거나 맞닿은 칸은 하나로 합친다 — 겹쳐 칠하면 그 자리만 진해 보인다.
    spans.sort((a, b) => a[0] - b[0]);
    let [left, right] = spans[0];
    for (let k = 1; k < spans.length; k++) {
      if (spans[k][0] <= right + 1e-6) {
        right = Math.max(right, spans[k][1]);
      } else {
        quads.push(left, top, right, top, left, bottom, right, bottom);
        [left, right] = spans[k];
      }
    }
    quads.push(left, top, right, top, left, bottom, right, bottom);
  }
  return quads;
}

/** 점 목록을 감싸는 네모 [x1,y1,x2,y2] */
export function boundingBox(points) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}
