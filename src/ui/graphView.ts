// 노트 그래프를 캔버스에 그리고 끌기·확대·마우스 올리기·클릭을 처리하는 화면
import type { GraphData } from '../lib/vault';
import { ALPHA_MIN, initNodes, step, type SimNode } from '../lib/graphSim';

export interface GraphView {
  setData(data: GraphData, focusId?: string): void;
  stop(): void;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createGraphView(canvas: HTMLCanvasElement, onOpen: (id: string) => void): GraphView {
  const ctx = canvas.getContext('2d')!;
  let data: GraphData = { nodes: [], edges: [] };
  let nodes: SimNode[] = [];
  let neighbors: Set<number>[] = [];
  let focus = -1;
  let alpha = 0;
  let frame = 0;
  // 화면 이동과 배율
  let view = { x: 0, y: 0, k: 0.5 };
  let hover = -1;
  let drag: { node: number; moved: boolean } | null = null;
  let pan: { x: number; y: number } | null = null;

  const radius = (i: number) => 4 + Math.sqrt(data.nodes[i].degree) * 2.5;

  function toWorld(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - view.x) / view.k, y: (e.clientY - r.top - r.height / 2 - view.y) / view.k };
  }

  function nodeAt(e: MouseEvent): number {
    const p = toWorld(e);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const hit = radius(i) + 3 / view.k;
      if ((nodes[i].x - p.x) ** 2 + (nodes[i].y - p.y) ** 2 <= hit * hit) return i;
    }
    return -1;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);

    const active = hover >= 0 ? hover : -1;
    const lit = (i: number) => active < 0 || i === active || neighbors[active].has(i);
    const fg = css('--fg');
    const muted = css('--muted');
    const accent = css('--accent');

    ctx.lineWidth = 1 / view.k;
    for (const [a, b] of data.edges) {
      const on = active >= 0 && (a === active || b === active);
      ctx.strokeStyle = on ? accent : muted;
      ctx.globalAlpha = active < 0 ? 0.35 : on ? 0.9 : 0.08;
      ctx.beginPath();
      ctx.moveTo(nodes[a].x, nodes[a].y);
      ctx.lineTo(nodes[b].x, nodes[b].y);
      ctx.stroke();
    }
    data.nodes.forEach((n, i) => {
      ctx.globalAlpha = lit(i) ? 1 : 0.15;
      ctx.fillStyle = i === focus || i === active ? accent : n.kind === 'tag' ? css('--tag') : n.kind === 'unresolved' ? muted : fg;
      ctx.beginPath();
      ctx.arc(nodes[i].x, nodes[i].y, radius(i), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.font = `${12 / view.k}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = fg;
    data.nodes.forEach((n, i) => {
      // 노트가 적으면 늘 이름을 쓰고, 많으면 확대했거나 연결이 많은 노드만 쓴다
      const show = active >= 0 ? lit(i) : data.nodes.length <= 60 || view.k > 0.6 || i === focus || n.degree >= 5;
      if (!show) return;
      ctx.globalAlpha = 1;
      ctx.fillText(n.label, nodes[i].x, nodes[i].y + radius(i) + 2 / view.k);
    });
    ctx.globalAlpha = 1;
  }

  function tick() {
    if (alpha > ALPHA_MIN) alpha = step(nodes, data.edges, alpha);
    draw();
    frame = alpha > ALPHA_MIN || drag ? requestAnimationFrame(tick) : 0;
  }

  function kick(a = 0.3) {
    alpha = Math.max(alpha, a);
    if (!frame) frame = requestAnimationFrame(tick);
  }

  canvas.onmousedown = (e) => {
    const i = nodeAt(e);
    if (i >= 0) {
      drag = { node: i, moved: false };
      nodes[i].fixed = true;
      kick();
    } else pan = { x: e.clientX - view.x, y: e.clientY - view.y };
  };
  window.addEventListener('mousemove', (e) => {
    if (canvas.offsetParent === null) return;
    if (drag) {
      const p = toWorld(e);
      Object.assign(nodes[drag.node], { x: p.x, y: p.y });
      drag.moved = true;
      kick();
    } else if (pan) {
      view.x = e.clientX - pan.x;
      view.y = e.clientY - pan.y;
      draw();
    } else if (e.target === canvas) {
      const i = nodeAt(e);
      if (i !== hover) {
        hover = i;
        canvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
        draw();
      }
    }
  });
  window.addEventListener('mouseup', () => {
    if (drag) {
      nodes[drag.node].fixed = false;
      const { node, moved } = drag;
      drag = null;
      if (!moved && data.nodes[node].kind === 'note') onOpen(data.nodes[node].id);
    }
    pan = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // 마우스 위치를 기준으로 확대·축소한다
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2;
    const my = e.clientY - r.top - r.height / 2;
    const k = Math.min(4, Math.max(0.05, view.k * Math.exp(-e.deltaY / 300)));
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
    draw();
  }, { passive: false });
  new ResizeObserver(() => draw()).observe(canvas);

  return {
    setData(next, focusId) {
      // 이미 있던 노드는 자리를 유지해서 다시 그려도 모양이 크게 바뀌지 않게 한다
      const old = new Map(data.nodes.map((n, i) => [n.id, nodes[i]]));
      const fresh = initNodes(next.nodes.length);
      nodes = next.nodes.map((n, i) => old.get(n.id) ?? fresh[i]);
      data = next;
      neighbors = next.nodes.map(() => new Set<number>());
      for (const [a, b] of next.edges) {
        neighbors[a].add(b);
        neighbors[b].add(a);
      }
      focus = next.nodes.findIndex((n) => n.id === focusId);
      hover = -1;
      if (old.size === 0) view = { x: 0, y: 0, k: next.nodes.length > 200 ? 0.25 : 0.5 };
      kick(old.size === 0 ? 1 : 0.3);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
