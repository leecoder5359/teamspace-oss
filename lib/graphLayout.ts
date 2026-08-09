/* =====================================================================
   힘기반 그래프 레이아웃. 순수·결정적(난수 없음).

   종전 그래프는 노드를 배열 인덱스 순서대로 원 둘레에 놓았다. 예쁘지만
   **군집이 보이지 않는다** — 어떤 문서 뭉치가 서로 붙어 있는지가 그래프를
   보는 유일한 이유인데 그게 안 나왔다.

   여기서는 고전적인 스프링-전하 모형을 돌린다:
     - 모든 노드쌍은 서로 밀어낸다(전하)
     - 간선으로 이어진 쌍은 당긴다(스프링)
     - 전체를 중심으로 약하게 모은다(중력)
   초기 배치는 황금각 나선이라 난수가 없다 — 같은 입력이면 항상 같은 그림이
   나오고, 그래야 테스트할 수 있고 사용자도 "어제 그 모양"을 다시 본다.
   ===================================================================== */

export type LayoutNode = { id: string };
export type LayoutEdge = { from: string; to: string };
export type Point = { x: number; y: number };

export type LayoutOptions = {
  width?: number;
  height?: number;
  iterations?: number;
  /** 반발 계수 — 크면 넓게 퍼진다 */
  repulsion?: number;
  /** 스프링 계수 — 크면 연결된 것끼리 바짝 붙는다 */
  attraction?: number;
  /** 중심으로 모으는 힘 */
  gravity?: number;
};

const DEFAULTS = {
  width: 1200,
  height: 720,
  iterations: 320,
  repulsion: 9000,
  attraction: 0.012,
  gravity: 0.025,
};

/** 황금각 나선 — 초기 배치를 난수 없이 고르게 흩는다. */
function seedPositions(nodes: LayoutNode[], w: number, h: number): Map<string, Point> {
  const pos = new Map<string, Point>();
  const cx = w / 2;
  const cy = h / 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const maxR = Math.min(w, h) * 0.42;
  nodes.forEach((n, i) => {
    const t = nodes.length <= 1 ? 0 : i / (nodes.length - 1);
    const r = maxR * Math.sqrt(t);
    const a = i * golden;
    pos.set(n.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  });
  return pos;
}

/**
 * 레이아웃을 계산한다. 반환 좌표는 [0,width]×[0,height] 안으로 클램프된다.
 * 노드 수가 많아지면 O(n²) 반발이 부담이라 반복수를 자동으로 줄인다.
 */
export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions = {},
): Map<string, Point> {
  const w = opts.width ?? DEFAULTS.width;
  const h = opts.height ?? DEFAULTS.height;
  const repulsion = opts.repulsion ?? DEFAULTS.repulsion;
  const attraction = opts.attraction ?? DEFAULTS.attraction;
  const gravity = opts.gravity ?? DEFAULTS.gravity;

  const pos = seedPositions(nodes, w, h);
  if (nodes.length <= 1) return pos;

  // 노드가 많으면 반복을 줄인다 — 브라우저에서 한 프레임을 넘기지 않게
  const baseIter = opts.iterations ?? DEFAULTS.iterations;
  const iterations = Math.max(60, Math.round(baseIter * Math.min(1, 120 / nodes.length)));

  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  // 양 끝이 실재하고 자기참조가 아닌 간선만 스프링으로 쓴다
  const springs = edges.filter((e) => e.from !== e.to && idSet.has(e.from) && idSet.has(e.to));

  const cx = w / 2;
  const cy = h / 2;
  const disp = new Map<string, Point>();

  for (let step = 0; step < iterations; step++) {
    // 온도: 초반엔 크게 움직이고 점점 식는다(진동 방지)
    const temp = (1 - step / iterations) * Math.min(w, h) * 0.06 + 0.5;
    for (const id of ids) disp.set(id, { x: 0, y: 0 });

    // 반발
    for (let i = 0; i < ids.length; i++) {
      const a = pos.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const b = pos.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // 완전히 겹치면 결정적으로 아주 조금 떼어놓는다(난수 금지)
          dx = (i - j) * 0.01 + 0.01;
          dy = (j - i) * 0.01 + 0.01;
          d2 = dx * dx + dy * dy;
        }
        const f = repulsion / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const da = disp.get(ids[i])!;
        const db = disp.get(ids[j])!;
        da.x += fx;
        da.y += fy;
        db.x -= fx;
        db.y -= fy;
      }
    }

    // 인력(간선)
    for (const e of springs) {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const fx = dx * attraction;
      const fy = dy * attraction;
      const da = disp.get(e.from)!;
      const db = disp.get(e.to)!;
      da.x -= fx;
      da.y -= fy;
      db.x += fx;
      db.y += fy;
    }

    // 중력 + 적용
    for (const id of ids) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      d.x += (cx - p.x) * gravity;
      d.y += (cy - p.y) * gravity;

      const len = Math.sqrt(d.x * d.x + d.y * d.y) || 1;
      const cap = Math.min(len, temp);
      p.x += (d.x / len) * cap;
      p.y += (d.y / len) * cap;

      // 화면 밖으로 나가지 않게
      p.x = Math.max(30, Math.min(w - 30, p.x));
      p.y = Math.max(30, Math.min(h - 30, p.y));
    }
  }

  return pos;
}

/** 각 노드의 연결 차수(무방향). 노드 크기에 쓴다. */
export function degrees(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const n of nodes) deg.set(n.id, 0);
  for (const e of edges) {
    if (deg.has(e.from)) deg.set(e.from, deg.get(e.from)! + 1);
    if (deg.has(e.to)) deg.set(e.to, deg.get(e.to)! + 1);
  }
  return deg;
}

/** id → 이웃 id 집합(무방향). 호버 하이라이트·깊이 필터에 쓴다. */
export function adjacency(edges: LayoutEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return adj;
}

/** from 에서 depth 홉 안에 닿는 노드 집합(자기 포함). */
export function withinDepth(adj: Map<string, Set<string>>, from: string, depth: number): Set<string> {
  const seen = new Set([from]);
  let frontier = [from];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return seen;
}
