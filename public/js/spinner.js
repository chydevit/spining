// Shows the wheel, slot machine, capsule machine or drop board, depending on the chosen style,
// behind one interface. Switching styles swaps the renderer when needed.
import { Wheel } from './wheel.js';
import { SlotMachine } from './slot.js';
import { CapsuleMachine } from './capsule.js';
import { PlinkoBoard } from './plinko.js';
import { getStyle } from './styles.js';

const kindOf = (style) => style.kind ?? 'wheel';

export class Spinner {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.closed = false;
    this.build(getStyle(opts.style));
  }

  build(style) {
    this.container.replaceChildren();
    this.container.classList.remove('wheel-stage', 'slot-stage', 'capsule-stage', 'plinko-stage', 'is-spinning', 'is-closed');
    const Impl = { slot: SlotMachine, capsule: CapsuleMachine, plinko: PlinkoBoard }[kindOf(style)] ?? Wheel;
    this.impl = new Impl(this.container, { ...this.opts, style: style.id });
    this.kind = kindOf(style);
    this.impl.setClosed(this.closed);
  }

  setStyle(style) {
    const st = typeof style === 'string' || !style ? getStyle(style) : style;
    if (kindOf(st) !== this.kind) {
      const segs = this.impl.segments;
      this.build(st);
      if (segs.length) this.impl.setSegments(segs);
    } else {
      this.impl.setStyle(st);
    }
  }

  get style() { return this.impl.style; }
  get segments() { return this.impl.segments; }
  get colors() { return this.impl.colors; }
  get spinning() { return this.impl.spinning; }
  /** The rendered element (SVG for the wheel, DIV for the slot machine). */
  get root() { return this.impl.root ?? this.impl.svg; }

  setSegments(segments) { this.impl.setSegments(segments); }
  spinTo(index, options) { return this.impl.spinTo(index, options); }
  highlight(index) { this.impl.highlight(index); }
  setClosed(closed) {
    this.closed = closed;
    this.impl.setClosed(closed);
  }
}
