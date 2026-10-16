// Arcade slot machine renderer — an alternative to the wheel (style kind "slot").
// Same interface as Wheel: setSegments, setStyle, spinTo, highlight, setClosed.
// The server still decides the outcome; all three reels simply stop on it.
import { labelColorFor } from './wheel.js';
import { getStyle, resolveColors } from './styles.js';

const LOOPS = 8; // how many times each reel repeats the symbols
const easeOut = (t) => 1 - (1 - t) ** 3;

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** A fixed shuffle per reel so the three reels don't look identical. */
function reelOrder(n, reel) {
  const order = Array.from({ length: n }, (_, i) => i);
  let seed = 7 + reel * 13;
  for (let i = n - 1; i > 0; i--) {
    seed = (seed * 9301 + 49297) % 233280;
    const j = Math.floor((seed / 233280) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export class SlotMachine {
  constructor(stage, { onTick, label = 'Prize slot machine', style } = {}) {
    this.stage = stage;
    this.onTick = onTick;
    this.label = label;
    this.style = getStyle(style);
    this.segments = [];
    this.colors = [];
    this.spinning = false;
    this.pos = [0, 0, 0]; // strip index shown on the pay line, per reel
    stage.classList.add('slot-stage');
    stage.dataset.wheelStyle = this.style.id;

    this.root = h('div', 'slot');
    this.root.setAttribute('role', 'img');
    const sign = h('div', 'slot-sign');
    sign.append(h('span', 'slot-star slot-star-l', '✦'), h('span', 'slot-sign-small', 'PharmKulen'), h('span', 'slot-sign-text', 'LUCKY SPIN'), h('span', 'slot-star slot-star-r', '✦'));

    const cabinet = h('div', 'slot-cabinet');
    const window_ = h('div', 'slot-window');
    this.window = window_;
    this.reels = [0, 1, 2].map(() => {
      const reel = h('div', 'slot-reel');
      const strip = h('div', 'slot-strip');
      reel.append(strip);
      window_.append(reel);
      return { reel, strip, order: [] };
    });
    window_.append(h('div', 'slot-payline'), h('span', 'slot-arrow slot-arrow-l'), h('span', 'slot-arrow slot-arrow-r'));
    const lamp = h('div', 'slot-lamp', 'SPIN');
    lamp.setAttribute('aria-hidden', 'true');
    cabinet.append(h('span', 'slot-arm slot-arm-l'), h('span', 'slot-arm slot-arm-r'), window_, lamp);

    this.showcase = h('div', 'slot-base');
    this.root.append(sign, cabinet, this.showcase);
    stage.append(this.root);
  }

  setStyle(style) {
    this.style = typeof style === 'string' || !style ? getStyle(style) : style;
    this.stage.dataset.wheelStyle = this.style.id;
    if (this.segments.length) this.setSegments(this.segments);
  }

  tile(seg, color) {
    const t = h('div', `slot-tile${seg.available === false ? ' is-off' : ''}`);
    t.style.setProperty('--tile', color);
    t.style.setProperty('--tile-ink', labelColorFor(color).color);
    if (seg.image) {
      const img = h('img', 'slot-img');
      img.src = seg.image;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      t.append(img);
      t.classList.add('has-image');
    }
    t.append(h('span', 'slot-label', seg.label));
    if (seg.available === false) t.append(h('span', 'slot-note', seg.soldOut ? 'All claimed' : 'Not in play'));
    return t;
  }

  setSegments(segments) {
    this.segments = segments;
    this.colors = resolveColors(this.style, segments);
    const n = segments.length;
    this.reels.forEach((r, ri) => {
      r.order = reelOrder(n, ri);
      const frag = document.createDocumentFragment();
      for (let loop = 0; loop < LOOPS; loop++) {
        for (const idx of r.order) frag.append(this.tile(segments[idx], this.colors[idx]));
      }
      r.strip.replaceChildren(frag);
      r.count = n * LOOPS;
      this.pos[ri] = n ? n + ri * 2 : 0; // start in the 2nd loop so a row shows above the pay line
      this.place(ri);
    });

    // Gifts panel at the bottom of the cabinet (pictures + names, no odds).
    const gifts = segments
      .map((s, i) => ({ s, color: this.colors[i] }))
      .filter(({ s }) => s.isPrize && s.available !== false)
      .filter(({ s }, i, arr) => arr.findIndex((x) => x.s.label === s.label) === i)
      .slice(0, 4);
    this.showcase.replaceChildren(
      h('p', 'slot-base-title', gifts.length ? 'Gifts you could win' : 'Thanks for playing!'),
      ...(gifts.length ? [(() => {
        const row = h('div', 'slot-gifts');
        for (const { s, color } of gifts) {
          const g = h('div', 'slot-gift');
          const pic = h('div', 'slot-gift-pic');
          pic.style.setProperty('--tile', color);
          if (s.image) {
            const img = h('img');
            img.src = s.image;
            img.alt = '';
            pic.append(img);
          } else {
            pic.textContent = '★';
            pic.style.color = labelColorFor(color).color;
          }
          g.append(pic, h('span', 'slot-gift-name', s.label));
          row.append(g);
        }
        return row;
      })()] : []),
    );

    const names = segments.map((s) => s.label).join(', ');
    this.root.setAttribute('aria-label', `${this.label} with ${n} possible outcomes: ${names}.`);
    this.highlight(-1);
  }

  /** Move reel `ri` so strip item `pos` sits on the pay line (middle row). */
  place(ri) {
    const r = this.reels[ri];
    if (!r.count) return;
    const shift = ((this.pos[ri] - 1) / r.count) * 100;
    r.strip.style.transform = `translateY(-${shift}%)`;
  }

  highlight(index) {
    this.window.classList.toggle('is-win', index >= 0);
  }

  setClosed(closed) {
    this.stage.classList.toggle('is-closed', closed);
  }

  spinTo(index, { duration = 2600, reducedMotion = false } = {}) {
    const n = this.segments.length;
    if (this.spinning || index < 0 || index >= n) return Promise.resolve();
    this.highlight(-1);
    this.spinning = true;
    this.stage.classList.add('is-spinning');

    const plans = this.reels.map((r, ri) => {
      // Rewind into the 2nd loop (looks identical) so there is room to spin forward.
      const start = n + (((this.pos[ri] % n) + n) % n);
      this.pos[ri] = start;
      const minTravel = reducedMotion ? n : n * (3 + ri);
      let target = start + minTravel;
      while (r.order[target % n] !== index) target++;
      const dur = reducedMotion ? 700 : duration + ri * 650;
      return { start, target, dur };
    });

    const last = plans.map((p) => Math.floor(p.start));
    const t0 = performance.now();
    return new Promise((resolve) => {
      const frame = (now) => {
        let done = true;
        plans.forEach((p, ri) => {
          const t = Math.min(1, (now - t0) / p.dur);
          if (t < 1) done = false;
          this.pos[ri] = p.start + (p.target - p.start) * easeOut(t);
          this.place(ri);
          const item = Math.floor(this.pos[ri] + 0.5);
          if (item !== last[ri]) {
            last[ri] = item;
            if (ri === 0 || t < 1) this.onTick?.();
          }
          if (t >= 1 && !p.stopped) {
            p.stopped = true;
            this.reels[ri].reel.classList.add('bump');
            setTimeout(() => this.reels[ri].reel.classList.remove('bump'), 220);
          }
        });
        if (!done) {
          requestAnimationFrame(frame);
        } else {
          this.spinning = false;
          this.stage.classList.remove('is-spinning');
          this.highlight(index);
          resolve();
        }
      };
      requestAnimationFrame(frame);
    });
  }
}
