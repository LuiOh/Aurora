// 노트 그래프의 노드 위치를 계산하는 d3-force 방식의 힘 기반 시뮬레이션

export interface SimNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 끌어서 잡고 있는 노드는 움직이지 않는다 */
  fixed?: boolean;
}

export interface SimParams {
  /** 노드끼리 밀어내는 힘 (양수) */
  repel: number;
  /** 링크가 당기는 힘. 연결이 많은 노드일수록 나눠서 약하게 건다 */
  linkStrength: number;
  linkDistance: number;
  /** 원점으로 모으는 힘 */
  center: number;
}

// 옵시디언 그래프 기본값과 같다 (척력 슬라이더 10의 세제곱, 링크 거리 250, 링크 힘 1, 중심 힘 0.1)
export const DEFAULT_PARAMS: SimParams = { repel: 1000, linkStrength: 1, linkDistance: 250, center: 0.1 };

const VELOCITY_DECAY = 0.4;
export const ALPHA_MIN = 0.001;
// 300단계쯤 지나면 alpha가 ALPHA_MIN까지 줄어든다
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);

/** 처음 위치는 해바라기 씨 모양(phyllotaxis)으로 고르게 펼친다. 무작위가 아니어서 늘 같은 모양으로 시작한다 */
export function initNodes(count: number): SimNode[] {
  const angle = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, i) => {
    const r = 10 * Math.sqrt(0.5 + i);
    return { x: r * Math.cos(i * angle), y: r * Math.sin(i * angle), vx: 0, vy: 0 };
  });
}

/**
 * alpha만큼 한 단계 진행하고 줄어든 alpha를 돌려준다. ALPHA_MIN보다 작아지면 멈춰도 된다.
 * 척력은 모든 쌍을 계산하는 O(n²)이라 노드 수천 개까지는 충분하다.
 */
export function step(nodes: SimNode[], links: [number, number][], alpha: number, p: SimParams = DEFAULT_PARAMS): number {
  const n = nodes.length;
  const degree = new Array<number>(n).fill(0);
  for (const [a, b] of links) {
    degree[a]++;
    degree[b]++;
  }

  // 척력: 거리에 반비례해 서로 밀어낸다
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dx = nodes[j].x - nodes[i].x;
      let dy = nodes[j].y - nodes[i].y;
      if (dx === 0 && dy === 0) {
        // 같은 자리에 겹친 노드는 살짝 비켜 놓는다
        dx = (j - i) * 1e-3;
        dy = 1e-3;
      }
      const l2 = Math.max(1, dx * dx + dy * dy);
      const w = (p.repel * alpha) / l2;
      nodes[i].vx -= dx * w;
      nodes[i].vy -= dy * w;
      nodes[j].vx += dx * w;
      nodes[j].vy += dy * w;
    }
  }

  // 링크: linkDistance로 맞춰지게 당기거나 민다. 연결이 적은 쪽이 더 많이 움직인다
  for (const [a, b] of links) {
    const s = nodes[a];
    const t = nodes[b];
    const dx = t.x + t.vx - s.x - s.vx || 1e-3;
    const dy = t.y + t.vy - s.y - s.vy || 1e-3;
    const d = Math.sqrt(dx * dx + dy * dy);
    const strength = p.linkStrength / Math.min(degree[a], degree[b]);
    const l = ((d - p.linkDistance) / d) * alpha * strength;
    const bias = degree[a] / (degree[a] + degree[b]);
    t.vx -= dx * l * bias;
    t.vy -= dy * l * bias;
    s.vx += dx * l * (1 - bias);
    s.vy += dy * l * (1 - bias);
  }

  for (const node of nodes) {
    if (node.fixed) {
      node.vx = node.vy = 0;
      continue;
    }
    node.vx -= node.x * p.center * alpha;
    node.vy -= node.y * p.center * alpha;
    node.vx *= 1 - VELOCITY_DECAY;
    node.vy *= 1 - VELOCITY_DECAY;
    node.x += node.vx;
    node.y += node.vy;
  }
  return alpha + (0 - alpha) * ALPHA_DECAY;
}
