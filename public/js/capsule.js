// Capsule (gacha) machine renderer — style kind "capsule".
// Same interface as Wheel / SlotMachine: setSegments, setStyle, spinTo, highlight, setClosed.
// Turning the knob drops one capsule in the server-chosen colour, which opens to show the result.
import { labelColorFor, monogram } from './wheel.js';
import { getStyle, resolveColors } from './styles.js';

const PILE = 32; // capsules shown in the dome

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

export class CapsuleMachine {
  constructor(stage, { onTick, label = 'Prize capsule machine', style } = {}) {
    this.stage = stage;
    this.onTick = onTick;
    this.label = label;
    this.style = getStyle(style);
    this.segments = [];
    this.colors = [];
    this.spinning = false;
    this.knobTurn = 0;
    stage.classList.add('capsule-stage');

    this.root = h('div', 'capsule');
    this.root.setAttribute('role', 'img');

    // Sign with gift pictures (like the character banner on real machines)
    this.sign = h('div', 'cap-sign');
    const logo = h('img', 'cap-sign-logo');
    logo.src = '/assets/pharmkulen-icon.png';
    logo.alt = '';
    this.sign.append(logo, h('span', 'cap-sign-big', 'Lucky Capsule'));

    // Glass dome with a pile of capsules
    this.dome = h('div', 'cap-dome');
    this.pile = h('div', 'cap-pile');
    this.reveal = h('div', 'cap-reveal');
    this.reveal.setAttribute('aria-hidden', 'true');
    this.dome.append(this.pile, h('div', 'cap-glass'), this.reveal);

    // Base: chute on the left, coin plate + knob on the right
    const base = h('div', 'cap-base');
    const chute = h('div', 'cap-chute');
    this.drop = h('div', 'cap-drop');
    this.drop.append(h('span', 'cap-drop-top'), h('span', 'cap-drop-bottom'));
    chute.append(h('div', 'cap-chute-hole'), this.drop, h('div', 'cap-chute-flap'));
    const plate = h('div', 'cap-plate');
    this.knob = h('div', 'cap-knob');
    this.knob.append(h('span', 'cap-knob-bar'));
    plate.append(h('div', 'cap-coin'), this.knob);
    base.append(chute, plate);

    this.root.append(this.sign, this.dome, base);
    stage.append(this.root);
  }

  setStyle(style) {
    this.style = typeof style === 'string' || !style ? getStyle(style) : style;
    if (this.segments.length) this.setSegments(this.segments);
  }

  setSegments(segments) {
    this.segments = segments;
    this.colors = resolveColors(this.style, segments);
    const n = segments.length;

    // Capsule pile: rows from the bottom, staggered, with a little jitter and tilt.
    const rand = rng(11);
    const caps = [];
    const usable = segments.map((s, i) => i).filter((i) => segments[i].available !== false);
    const pool = usable.length ? usable : segments.map((s, i) => i);
    let k = 0;
    for (let row = 0; caps.length < PILE; row++) {
      const count = row % 2 ? 5 : 6;
      for (let i = 0; i < count && caps.length < PILE; i++) {
        const idx = pool[(k++ * 5 + row) % pool.length];
        const c = h('span', 'cap');
        const x = ((i + (row % 2 ? 0.5 : 0)) / 6) * 100 + (rand() - 0.5) * 4;
        const y = row * 13.5 + (rand() - 0.5) * 3;
        c.style.left = `${Math.max(0, Math.min(84, x))}%`;
        c.style.bottom = `${y}%`;
        c.style.setProperty('--c', this.colors[idx]);
        c.style.setProperty('--r', `${Math.round((rand() - 0.5) * 140)}deg`);
        c.style.setProperty('--d', `${(rand() * 0.25).toFixed(2)}s`);
        c.style.zIndex = 20 - row; // lower rows sit in front
        c.style.setProperty('--s', `${(14.5 + rand() * 3).toFixed(1)}%`); // slightly mixed sizes
        caps.push(c);
      }
    }
    this.pile.replaceChildren(...caps);

    this.reset();
    this.root.setAttribute('aria-label', `${this.label} with ${n} possible outcomes: ${segments.map((s) => s.label).join(', ')}.`);
  }

  reset() {
    this.drop.className = 'cap-drop';
    this.reveal.className = 'cap-reveal';
    this.reveal.replaceChildren();
    this.root.classList.remove('is-prize');
  }

  highlight(index) {
    this.root.classList.toggle('is-win', index >= 0);
  }

  setClosed(closed) {
    this.stage.classList.toggle('is-closed', closed);
  }

  showReveal(seg, color) {
    const card = h('div', 'cap-reveal-card');
    const pic = h('div', 'cap-reveal-pic');
    pic.style.setProperty('--c', color);
    if (seg.image) {
      const img = h('img');
      img.src = seg.image;
      img.alt = '';
      pic.append(img);
    } else {
      pic.textContent = monogram(seg.label);
      pic.style.color = labelColorFor(color).color;
    }
    if (seg.isPrize) card.append(h('span', 'cap-reveal-caption', 'You won'));
    card.append(pic, h('span', 'cap-reveal-label', seg.label));
    this.reveal.replaceChildren(card);
    this.reveal.classList.add('show');
    this.root.classList.toggle('is-prize', !!seg.isPrize);
  }

  async spinTo(index, { reducedMotion = false } = {}) {
    if (this.spinning || index < 0 || index >= this.segments.length) return;
    this.spinning = true;
    this.highlight(-1);
    this.reset();
    this.stage.classList.add('is-spinning');
    const color = this.colors[index];
    this.drop.style.setProperty('--c', color);

    if (reducedMotion) {
      this.drop.classList.add('landed', 'open');
      this.showReveal(this.segments[index], color);
      await wait(300);
    } else {
      // 1. Turn the knob twice while the capsules tumble.
      this.knobTurn += 720;
      this.knob.style.transform = `rotate(${this.knobTurn}deg)`;
      for (let t = 0; t < 12; t++) {
        this.onTick?.();
        await wait(130);
      }
      // 2. A capsule drops into the chute and bounces.
      this.drop.classList.add('dropping');
      this.onTick?.();
      await wait(750);
      this.drop.classList.add('landed');
      await wait(250);
      // 3. It pops open and the result floats up.
      this.drop.classList.add('open');
      this.showReveal(this.segments[index], color);
      await wait(650);
    }

    this.spinning = false;
    this.stage.classList.remove('is-spinning');
    this.highlight(index);
  }
}
