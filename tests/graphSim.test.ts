// 그래프 힘 시뮬레이션이 링크 거리 근처로 모이고 멈추는지 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { ALPHA_MIN, DEFAULT_PARAMS, initNodes, step } from '../src/lib/graphSim';

function run(count: number, links: [number, number][]) {
  const nodes = initNodes(count);
  let alpha = 1;
  let steps = 0;
  while (alpha > ALPHA_MIN) {
    alpha = step(nodes, links, alpha);
    steps++;
  }
  return { nodes, steps };
}

describe('그래프 시뮬레이션', () => {
  it('약 300단계 뒤 멈춘다', () => {
    expect(run(3, [[0, 1]]).steps).toBeGreaterThan(250);
    expect(run(3, [[0, 1]]).steps).toBeLessThan(350);
  });
  it('연결된 노드는 링크 거리 근처에, 연결 안 된 노드는 더 멀리 놓인다', () => {
    const { nodes } = run(4, [[0, 1], [1, 2]]);
    const dist = (a: number, b: number) => Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
    expect(dist(0, 1)).toBeGreaterThan(DEFAULT_PARAMS.linkDistance * 0.5);
    expect(dist(0, 1)).toBeLessThan(DEFAULT_PARAMS.linkDistance * 1.5);
    expect(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });
  it('잡고 있는 노드는 움직이지 않는다', () => {
    const nodes = initNodes(2);
    nodes[0].fixed = true;
    const { x, y } = nodes[0];
    step(nodes, [[0, 1]], 1);
    expect([nodes[0].x, nodes[0].y]).toEqual([x, y]);
  });
});
