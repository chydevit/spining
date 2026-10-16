// Claw (crane) machine renderer — style kind "claw".
// Same interface as Wheel / SlotMachine / CapsuleMachine: setSegments, setStyle, spinTo, highlight, setClosed.
// The server has already chosen the outcome: the claw always picks up a prize of that outcome,
// carries it to the chute and the result pops up in the window.
import { labelColorFor, monogram, pictureBox } from './wheel.js';
import { getStyle, resolveColors } from './styles.js';

const MIN_PILE = 9; // prizes shown in the window
const HOME_X = 50; // crane rest position, % of the window width
const CHUTE_X = 15; // where the crane lets go, over the chute

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Fixed pseudo-random numbers so the pile looks natural but never jumps between renders. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class ClawMachine {
  constructor(stage, { onTick, label = 'Prize claw machine', style } = {}) {
    this.stage = stage;
    this.onTick = onTick;
    this.label = label;
    this.style = getStyle(style);
    this.segments = [];
    this.colors = [];
    this.spinning = false;
    this.closed = false;
    stage.classList.add('claw-stage');

    this.root = h('div', 'claw');
    this.root.setAttribute('role', 'img');

    // Head: beacon, two eyes that follow the claw, and a status display between them.
    const head = h('div', 'claw-head');
    this.eyes = [h('span', 'claw-eye claw-eye-l'), h('span', 'claw-eye claw-eye-r')];
    for (const eye of this.eyes) eye.append(h('span', 'claw-pupil'), h('span', 'claw-lid'));
    this.display = h('div', 'claw-display');
    this.displayText = h('span', 'claw-display-text', 'PRESS SPIN');
    this.display.append(this.displayText);
    head.append(h('span', 'claw-beacon'), this.eyes[0], this.display, this.eyes[1]);

    // Window: rail, crane, prize pile, chute, teeth along the rim, result card.
    this.window = h('div', 'claw-window');
    this.crane = h('div', 'claw-crane');
    this.grip = h('div', 'claw-grip');
    this.grip.append(h('span', 'claw-hub'), h('span', 'claw-arm claw-arm-l'), h('span', 'claw-arm claw-arm-r'));
    this.crane.append(h('span', 'claw-cable'), this.grip);
    this.pile = h('div', 'claw-pile');
    this.chute = h('div', 'claw-chute');
    this.chute.append(h('span', 'claw-chute-label', 'PRIZE'));
    this.reveal = h('div', 'claw-reveal');
    this.reveal.setAttribute('aria-hidden', 'true');
    const teeth = (where, count) => {
      const row = h('div', `claw-teeth claw-teeth-${where}`);
      for (let i = 0; i < count; i++) row.append(h('span'));
      return row;
    };
    this.window.append(h('span', 'claw-rail'), this.pile, this.chute, this.crane, teeth('top', 6), teeth('bottom', 4), this.reveal);

    // Control panel: the arrows and OK light up while the machine plays (the Spin button starts it).
    const panel = h('div', 'claw-panel');
    this.btnLeft = h('span', 'claw-btn claw-btn-arrow claw-btn-left');
    this.btnRight = h('span', 'claw-btn claw-btn-arrow claw-btn-right');
    this.btnOk = h('span', 'claw-btn claw-btn-ok', 'OK');
    panel.setAttribute('aria-hidden', 'true');
    panel.append(this.btnLeft, this.btnRight, this.btnOk);

    const base = h('div', 'claw-base');
    base.append(h('span', 'claw-fan'), h('span', 'claw-grille'), h('span', 'claw-fan'));

    this.root.append(head, this.window, panel, base);
    stage.append(this.root);
    this.moveCrane(HOME_X);
  }

  setStyle(style) {
    this.style = typeof style === 'string' || !style ? getStyle(style) : style;
    if (this.segments.length) this.setSegments(this.segments);
  }

  setSegments(segments) {
    this.segments = segments;
    this.colors = resolveColors(this.style, segments);
    this.renderPile();
    this.reset();
    this.root.setAttribute('aria-label', `${this.label} with ${segments.length} possible outcomes: ${segments.map((s) => s.label).join(', ')}.`);
  }

  /** Every outcome gets at least one prize in the pile; extra places repeat the gifts. */
  renderPile() {
    const n = this.segments.length;
    const order = this.segments.map((s, i) => i);
    const gifts = order.filter((i) => this.segments[i].isPrize);
    const extra = gifts.length ? gifts : order;
    for (let k = 0; order.length < Math.max(MIN_PILE, n); k++) order.push(extra[k % extra.length]);

    // Shuffle with a fixed seed so each render looks the same.
    const rand = rng(23);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    // Two staggered rows to the right of the chute; the back row sits higher and behind.
    const back = Math.floor(order.length / 2);
    const rows = [order.slice(0, back), order.slice(back)];
    const items = [];
    rows.forEach((row, r) => {
      row.forEach((idx, c) => {
        const seg = this.segments[idx];
        const color = this.colors[idx];
        const t = h('span', `claw-prize${seg.available === false ? ' is-off' : ''}`);
        // Spread each row evenly between the chute and the right wall; the back row is offset by half a step.
        const from = 38;
        const to = 88;
        const step = (to - from) / Math.max(1, row.length - (r ? 1 : 0.5));
        const x = from + step * (c + (r ? 0 : 0.25));
        t.style.left = `${x + (rand() - 0.5) * 2}%`;
        t.style.bottom = `${(r ? 6 : 20) + (rand() - 0.5) * 3}%`;
        t.style.zIndex = r ? 3 : 2;
        t.style.setProperty('--c', color);
        t.style.setProperty('--ink', labelColorFor(color).color);
        t.style.setProperty('--tilt', `${Math.round((rand() - 0.5) * 24)}deg`);
        t.dataset.index = idx;
        if (seg.image) {
          const img = h('img');
          img.src = seg.image;
          img.alt = '';
          img.addEventListener('error', () => img.replaceWith(monogram(seg.label)));
          t.append(img);
          pictureBox(t, seg); // a picture replaces the gift box: on its background disc, or bare
        } else {
          t.textContent = monogram(seg.label);
        }
        items.push(t);
      });
    });
    this.pile.replaceChildren(...items);
  }

  reset() {
    this.reveal.className = 'claw-reveal';
    this.reveal.replaceChildren();
    this.root.classList.remove('is-prize');
    this.grip.querySelector('.claw-prize')?.remove();
    for (const t of this.pile.children) t.classList.remove('is-taken');
    this.crane.style.removeProperty('--reach');
    this.grip.classList.remove('is-closed');
    this.moveCrane(HOME_X, 0);
    this.setDisplay(this.closed ? 'CLOSED' : 'PRESS SPIN');
  }

  setDisplay(text) {
    this.displayText.textContent = text;
  }

  /** Slide the crane to x (% of the window width); the eyes follow it. */
  moveCrane(x, ms = 0) {
    this.crane.style.setProperty('--move', `${ms}ms`);
    this.crane.style.left = `${x}%`;
    const look = Math.max(-1, Math.min(1, (x - 50) / 40));
    this.root.style.setProperty('--look', look.toFixed(2));
  }

  highlight(index) {
    this.root.classList.toggle('is-win', index >= 0);
  }

  setClosed(closed) {
    this.closed = closed;
    this.stage.classList.toggle('is-closed', closed);
    if (!this.spinning && !this.root.classList.contains('is-win')) this.setDisplay(closed ? 'CLOSED' : 'PRESS SPIN');
  }

  showReveal(seg, color) {
    const card = h('div', 'claw-reveal-card');
    const pic = h('div', 'claw-reveal-pic');
    pic.style.setProperty('--c', color);
    if (seg.image) {
      const img = h('img');
      img.src = seg.image;
      img.alt = '';
      pic.append(img);
      pictureBox(pic, seg);
    } else {
      pic.textContent = monogram(seg.label);
      pic.style.color = labelColorFor(color).color;
    }
    if (seg.isPrize) card.append(h('span', 'claw-reveal-caption', 'You won'));
    card.append(pic, h('span', 'claw-reveal-label', seg.label));
    this.reveal.replaceChildren(card);
    this.reveal.classList.add('show');
    this.root.classList.toggle('is-prize', !!seg.isPrize);
    this.setDisplay(seg.isPrize ? 'YOU WON' : seg.label.toUpperCase());
  }

  press(btn, ms) {
    btn.classList.add('is-pressed');
    setTimeout(() => btn.classList.remove('is-pressed'), ms);
  }

  /** Tick sounds while something moves. */
  async ticking(ms, every = 140) {
    for (let t = 0; t < ms; t += every) {
      this.onTick?.();
      await wait(every);
    }
  }

  async spinTo(index, { reducedMotion = false } = {}) {
    if (this.spinning || index < 0 || index >= this.segments.length) return;
    this.spinning = true;
    this.reset();
    this.highlight(-1);
    this.stage.classList.add('is-spinning');
    this.setDisplay('GOOD LUCK!');
    const seg = this.segments[index];
    const color = this.colors[index];

    // The prize to pick: one of the chosen outcome, front row first.
    const candidates = [...this.pile.children].filter((t) => Number(t.dataset.index) === index);
    const target = candidates.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0];

    if (reducedMotion || !target) {
      if (target) target.classList.add('is-taken');
      this.showReveal(seg, color);
      await wait(300);
    } else {
      const win = this.window.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      const x = ((box.left + box.width / 2 - win.left) / win.width) * 100;
      const craneBox = this.crane.getBoundingClientRect();
      const restReach = craneBox.height;
      const reach = box.top + box.height * 0.62 - craneBox.top; // crane length that puts the claw around the prize

      // 1. Slide across to the prize.
      const moveMs = 500 + Math.abs(x - HOME_X) * 22;
      this.press(x < HOME_X ? this.btnLeft : this.btnRight, moveMs);
      this.moveCrane(x, moveMs);
      await this.ticking(moveMs);
      // 2. Press OK: drop, close the claw, pick it up.
      this.press(this.btnOk, 400);
      this.crane.style.setProperty('--reach', `${reach}px`);
      await this.ticking(800, 200);
      this.grip.classList.add('is-closed');
      await wait(300);
      const held = target.cloneNode(true);
      held.classList.remove('is-taken');
      held.classList.add('claw-held');
      held.removeAttribute('style');
      for (const v of ['--c', '--ink', '--pic-bg']) held.style.setProperty(v, target.style.getPropertyValue(v));
      this.grip.append(held);
      target.classList.add('is-taken');
      this.crane.style.setProperty('--reach', `${restReach}px`);
      await this.ticking(800, 200);
      // 3. Carry it to the chute and let go.
      const backMs = 500 + Math.abs(x - CHUTE_X) * 18;
      this.press(this.btnLeft, backMs);
      this.moveCrane(CHUTE_X, backMs);
      await this.ticking(backMs);
      this.grip.classList.remove('is-closed');
      held.classList.add('is-dropping');
      this.onTick?.();
      await wait(550);
      held.remove();
      // 4. The result pops up.
      this.showReveal(seg, color);
      await wait(600);
    }

    this.spinning = false;
    this.stage.classList.remove('is-spinning');
    this.highlight(index);
  }
}
