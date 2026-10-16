// Pachinko / Plinko board renderer — style kind "plinko".
// Same interface as Wheel / SlotMachine / CapsuleMachine.
// A ball shoots up the side lane, bounces down through the pegs and lands in the
// slot of the result the server already chose (the path is planned to end there).
import { labelColorFor } from './wheel.js';
import { getStyle, resolveColors } from './styles.js';

// Board geometry, in % of the board box.
const ROWS = 8;
const TOP = 14; // first peg row
const BOTTOM = 61; // last peg row
const LEFT = 5;
const RIGHT = 84; // right of this is the launch lane
const SLOT_TOP = 69;
const BALL_REST = SLOT_TOP + 4.5; // ball sits at the top of its slot, above the name
const LANE_X = 92;

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const rowY = (r) => TOP + ((BOTTOM - TOP) * r) / (ROWS - 1);
const pegCols = (r) => (r % 2 ? 7 : 8);
// Even rows: 8 pegs; odd rows: 7 pegs offset by half a step (staggered).
const pegX = (r, c) => LEFT + ((RIGHT - LEFT) / 8) * (c + (r % 2 ? 1 : 0.5));

export class PlinkoBoard {
  constructor(stage, { onTick, label = 'Prize drop board', style } = {}) {
    this.stage = stage;
    this.onTick = onTick;
    this.label = label;
    this.style = getStyle(style);
    this.segments = [];
    this.colors = [];
    this.spinning = false;
    stage.classList.add('plinko-stage');

    this.root = h('div', 'plinko');
    this.root.setAttribute('role', 'img');

    const sign = h('div', 'pk-sign');
    sign.append(h('span', 'pk-sign-small', 'PharmKulen'), h('span', 'pk-sign-big', 'LUCKY DROP'));

    const cabinet = h('div', 'pk-cabinet');
    this.board = h('div', 'pk-board');
    this.pegs = [];
    const pegLayer = h('div', 'pk-pegs');
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < pegCols(r); c++) {
        const p = h('span', 'pk-peg', '★');
        p.style.left = `${pegX(r, c)}%`;
        p.style.top = `${rowY(r)}%`;
        pegLayer.append(p);
        row.push(p);
      }
      this.pegs.push(row);
    }
    const lane = h('div', 'pk-lane');
    const meter = h('div', 'pk-meter');
    for (let i = 0; i < 8; i++) meter.append(h('span'));
    this.slots = h('div', 'pk-slots');
    this.ball = h('div', 'pk-ball');
    this.board.append(h('div', 'pk-arch'), pegLayer, lane, meter, this.slots, this.ball);

    const lamp = h('div', 'pk-lamp', 'DROP');
    lamp.setAttribute('aria-hidden', 'true');
    cabinet.append(this.board, lamp);
    this.root.append(sign, cabinet);
    stage.append(this.root);
    this.parkBall();
  }

  setStyle(style) {
    this.style = typeof style === 'string' || !style ? getStyle(style) : style;
    if (this.segments.length) this.setSegments(this.segments);
  }

  setSegments(segments) {
    this.segments = segments;
    this.colors = resolveColors(this.style, segments);
    const n = segments.length;
    this.slots.style.setProperty('--n', n);
    this.slots.classList.toggle('is-narrow', n > 6);
    this.slotEls = segments.map((seg, i) => {
      const slot = h('div', `pk-slot${seg.available === false ? ' is-off' : ''}`);
      slot.style.setProperty('--c', this.colors[i]);
      slot.style.setProperty('--ink', labelColorFor(this.colors[i]).color);
      if (seg.image) {
        const img = h('img', 'pk-slot-img');
        img.src = seg.image;
        img.alt = '';
        img.addEventListener('error', () => img.remove());
        slot.append(img);
      } else if (seg.isPrize) {
        slot.append(h('span', 'pk-slot-star', '★'));
      }
      slot.append(h('span', 'pk-slot-label', seg.label));
      return slot;
    });
    this.slots.replaceChildren(...this.slotEls);
    this.root.setAttribute('aria-label', `${this.label} with ${n} slots: ${segments.map((s) => s.label).join(', ')}.`);
    this.highlight(-1);
    this.parkBall();
  }

  slotCenter(i) {
    const n = this.segments.length;
    return 1 + ((RIGHT + 2) * (i + 0.5)) / n; // slots span 1% … RIGHT+3%
  }

  placeBall(x, y) {
    this.ball.style.left = `${x}%`;
    this.ball.style.top = `${y}%`;
  }

  parkBall() {
    this.placeBall(LANE_X, 93);
  }

  highlight(index) {
    this.slotEls?.forEach((s, i) => s.classList.toggle('is-win', i === index));
  }

  setClosed(closed) {
    this.stage.classList.toggle('is-closed', closed);
  }

  /** Plan bounce points row by row so the walk ends above the target slot. */
  planPath(target) {
    const end = this.slotCenter(target);
    const start = 30 + Math.random() * 40;
    const walk = [start];
    const step = (RIGHT - LEFT) / 16;
    for (let r = 1; r < ROWS; r++) walk.push(walk[r - 1] + (Math.random() < 0.5 ? -step : step));
    return walk.map((x, r) => {
      const drift = (end - walk[ROWS - 1]) * (r / (ROWS - 1));
      return Math.max(LEFT, Math.min(RIGHT - 1, x + drift));
    });
  }

  animate(duration, fn) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / duration);
        fn(t);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  flashPeg(r, x) {
    let best = null;
    let bestD = Infinity;
    this.pegs[r].forEach((p, c) => {
      const d = Math.abs(pegX(r, c) - x);
      if (d < bestD) { bestD = d; best = p; }
    });
    if (!best) return;
    best.classList.remove('hit');
    void best.offsetWidth;
    best.classList.add('hit');
  }

  async spinTo(index, { reducedMotion = false } = {}) {
    if (this.spinning || index < 0 || index >= this.segments.length) return;
    this.spinning = true;
    this.highlight(-1);
    this.stage.classList.add('is-spinning');
    const end = this.slotCenter(index);

    if (reducedMotion) {
      this.placeBall(end, BALL_REST);
      await new Promise((r) => setTimeout(r, 300));
    } else {
      // 1. Shoot up the launch lane.
      this.onTick?.();
      await this.animate(450, (t) => this.placeBall(LANE_X, 93 - 86 * (1 - (1 - t) ** 3)));
      // 2. Curve over the top arch into the board.
      const path = this.planPath(index);
      const x0 = path[0];
      await this.animate(420, (t) => {
        const a = Math.PI * t;
        const x = LANE_X + (x0 - LANE_X) * t;
        const y = 7 - Math.sin(a) * 3 + (rowY(0) - 3 - 7) * t * t;
        this.placeBall(x, y);
      });
      // 3. Bounce down row by row.
      let px = x0;
      let py = rowY(0) - 3;
      for (let r = 0; r < ROWS; r++) {
        const nx = path[r];
        const ny = rowY(r) - 3;
        const hop = r === 0 ? 0 : 2.4;
        await this.animate(r === 0 ? 120 : 170, (t) => {
          this.placeBall(px + (nx - px) * t, py + (ny - py) * t * t - Math.sin(Math.PI * t) * hop);
        });
        this.flashPeg(r, nx);
        this.onTick?.();
        px = nx;
        py = ny;
      }
      // 4. Drop into the slot.
      await this.animate(380, (t) => this.placeBall(px + (end - px) * t, py + (BALL_REST - py) * t * t));
      this.onTick?.();
    }

    this.spinning = false;
    this.stage.classList.remove('is-spinning');
    this.highlight(index);
  }
}
