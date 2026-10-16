// Pachinko / Plinko board renderer — style kind "plinko".
// Same interface as Wheel / SlotMachine / CapsuleMachine.
// A ball shoots up the side lane, bounces down through the pegs and lands in the
// slot of the result the server already chose (the path is planned to end there).
import { labelColorFor, monogram, pictureBox } from './wheel.js';
import { getStyle, resolveColors } from './styles.js';
import { brandIcon } from './brand.js';

// Board geometry, in % of the board box.
const ROWS = 8;
const TOP = 16; // first peg row
const BOTTOM = 61; // last peg row
const LEFT = 5;
const RIGHT = 84; // right of this is the launch lane
const SLOT_TOP = 69;
const BALL_REST = SLOT_TOP + 2.4; // ball sits at the top of its slot, just above the badge
const LANE_X = 92;
const CX = (LEFT + RIGHT) / 2;
const SPACING = (RIGHT - LEFT) / (ROWS + 2); // between pegs in a row
const HALF = SPACING / 2; // one bounce moves the ball half a step left or right

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const rowY = (r) => TOP + ((BOTTOM - TOP) * r) / (ROWS - 1);
// A classic Plinko triangle: 3 pegs in the top row, one more in each row below, staggered,
// so a ball bouncing off a peg lands exactly on a peg of the next row.
const pegCols = (r) => r + 3;
const pegX = (r, c) => CX + (c - (r + 2) / 2) * SPACING;

/**
 * Marquee bulbs set into a rounded frame, numbered clockwise so they can chase.
 * rt / rb: corner radii of the frame's centre line (cqw); across / down: bulbs per straight edge.
 * Keep the total (4 corners + 2 × across + 2 × down) a multiple of 3 so the chase loops evenly.
 */
export function marqueeLights({ rt, rb, across, down }) {
  const layer = h('div', 'pk-lights');
  layer.setAttribute('aria-hidden', 'true');
  const c = (r) => `${(r * (1 - Math.SQRT1_2)).toFixed(2)}cqw`; // bulb on the corner arc at 45°
  const along = (from, to, n, k) => `calc(${from}cqw + (100% - ${from + to}cqw) * ${((k + 0.5) / n).toFixed(4)})`;
  const spots = [[c(rt), c(rt)]];
  for (let k = 0; k < across; k++) spots.push([along(rt, rt, across, k), '0%']);
  spots.push([`calc(100% - ${c(rt)})`, c(rt)]);
  for (let k = 0; k < down; k++) spots.push(['100%', along(rt, rb, down, k)]);
  spots.push([`calc(100% - ${c(rb)})`, `calc(100% - ${c(rb)})`]);
  for (let k = across - 1; k >= 0; k--) spots.push([along(rb, rb, across, k), '100%']);
  spots.push([c(rb), `calc(100% - ${c(rb)})`]);
  for (let k = down - 1; k >= 0; k--) spots.push(['0%', along(rt, rb, down, k)]);
  spots.forEach(([left, top], i) => {
    const bulb = h('span', `pk-bulb pk-bulb-${i % 3}${i % 2 ? ' pk-bulb-odd' : ''}`);
    bulb.style.left = left;
    bulb.style.top = top;
    layer.append(bulb);
  });
  return layer;
}

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
    const logo = h('img', 'pk-sign-logo');
    logo.src = brandIcon();
    logo.dataset.brand = 'icon';
    logo.alt = '';
    // Sign frame: 4cqw corners minus half its 0.8cqw border; 4 + 2×9 + 2×1 = 24 bulbs.
    sign.append(marqueeLights({ rt: 3.6, rb: 3.6, across: 9, down: 1 }), logo, h('span', 'pk-sign-big', 'Lucky Drop'));

    const cabinet = h('div', 'pk-cabinet');
    this.board = h('div', 'pk-board');
    this.pegs = [];
    const pegLayer = h('div', 'pk-pegs');
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < pegCols(r); c++) {
        const p = h('span', 'pk-peg'); // PharmKulen logo pin (see CSS)
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
      const slot = h('div', `pk-slot${seg.isPrize ? ' is-prize' : ''}${seg.available === false ? ' is-off' : ''}`);
      slot.style.setProperty('--c', this.colors[i]);
      slot.style.setProperty('--ink', labelColorFor(this.colors[i]).color);
      // Every slot gets the same round badge: the gift's picture, else its first letter.
      const glyph = monogram(seg.label);
      const icon = h('span', 'pk-slot-icon');
      if (seg.image) {
        const img = h('img');
        img.src = seg.image;
        img.alt = '';
        img.addEventListener('error', () => img.replaceWith(glyph));
        icon.append(img);
        pictureBox(icon, seg);
      } else {
        icon.textContent = glyph;
      }
      const label = h('span', 'pk-slot-label');
      label.append(h('span', '', seg.label));
      slot.append(icon, label);
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
    this.root.classList.toggle('is-won', index >= 0); // all the bulbs flash together
  }

  setClosed(closed) {
    this.stage.classList.toggle('is-closed', closed);
  }

  /** Plan the peg hit in each row: a random walk of half steps that is steered to end above the target slot. */
  planPath(target) {
    const end = this.slotCenter(target);
    // Each remaining row can move the ball HALF closer; the last fall into the slot covers up to HALF more.
    const inReach = (x, rowsLeft) => Math.abs(end - x) <= (rowsLeft + 1) * HALF;
    const top = Array.from({ length: pegCols(0) }, (_, c) => pegX(0, c));
    const starts = top.filter((x) => inReach(x, ROWS - 1));
    let x = starts.length
      ? starts[Math.floor(Math.random() * starts.length)]
      : top.reduce((a, b) => (Math.abs(end - b) < Math.abs(end - a) ? b : a)); // edge slot: start nearest
    const path = [x];
    for (let r = 1; r < ROWS; r++) {
      let dir = Math.random() < 0.5 ? -1 : 1;
      if (!inReach(x + dir * HALF, ROWS - 1 - r)) dir = Math.sign(end - x) || dir; // steer back on course
      x += dir * HALF;
      path.push(x);
    }
    return path;
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
