// Shared SVG wheel renderer, used by the player game and the admin preview.
// Its look (colours, rim, lights, pointer, hub, lettering) comes from a style preset in styles.js.
const SVG_NS = 'http://www.w3.org/2000/svg';
import { getStyle, resolveColors } from './styles.js';
import { brandIcon } from './brand.js';

// Geometry in SVG units. The rim (if the style has one) eats into the segment radius.
const R_OUTER = 198;
const R_HUB = 44;
const INK = '#053B40';
let instance = 0;

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Choose readable label colour for a segment fill. */
/**
 * Style the box (or <img>) that shows a gift picture: on a round disc in the gift's
 * picture background colour, or bare (as uploaded) when it has none. See .pic-bg / .pic-bare.
 */
export function pictureBox(el, seg) {
  const bg = seg?.imageBg || null;
  el.classList.toggle('pic-bg', !!bg);
  el.classList.toggle('pic-bare', !bg);
  if (bg) el.style.setProperty('--pic-bg', bg);
  else el.style.removeProperty('--pic-bg');
  return el;
}

/** First letter of an outcome's name, shown when a gift has no picture ("Tote Bag" → "T"). */
export function monogram(label) {
  const ch = String(label ?? '').trim().match(/\p{L}|\p{N}/u);
  return ch ? ch[0].toLocaleUpperCase() : '•';
}

export function labelColorFor(fill) {
  const white = contrast(fill, '#FFFFFF');
  const ink = contrast(fill, INK);
  return white >= ink ? { color: '#FFFFFF', needsHalo: white < 4.5 } : { color: INK, needsHalo: false };
}

function polar(r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [r * Math.cos(rad), r * Math.sin(rad)];
}

function arcPath(r, a0, a1) {
  if (a1 - a0 >= 359.999) {
    return `M 0 ${-r} A ${r} ${r} 0 1 1 0 ${r} A ${r} ${r} 0 1 1 0 ${-r} Z`;
  }
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M 0 0 L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`;
}

/** Split a label into at most two balanced lines. */
function wrapLabel(label) {
  if (label.length <= 11 || !label.includes(' ')) return [label];
  const words = label.split(/\s+/);
  let best = [label];
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.max(a.length, b.length);
    if (score < bestScore) {
      bestScore = score;
      best = [a, b];
    }
  }
  return best;
}

const easeOut = (t) => 1 - (1 - t) ** 4;

/** Why a segment can't be landed on right now. */
export function unavailableNote(seg) {
  return seg.soldOut ? 'All claimed' : 'Not in play';
}

export class Wheel {
  /**
   * @param {HTMLElement} stage  container element (gets .wheel-stage)
   * @param {object} opts { iconSrc, onTick, label, style }
   */
  constructor(stage, { iconSrc, onTick, label = 'Prize wheel', style } = {}) {
    this.stage = stage;
    this.onTick = onTick;
    this.label = label;
    this.iconSrc = iconSrc;
    this.id = `wheel${++instance}`;
    this.rotation = 0;
    this.segments = [];
    this.colors = [];
    this.spinning = false;
    this.style = getStyle(style);
    stage.classList.add('wheel-stage');

    this.svg = el('svg', { viewBox: '-204 -216 408 422', class: 'wheel-svg', role: 'img', focusable: 'false' });
    this.defs = el('defs', {}, this.svg);
    const hatch = el('pattern', { id: `${this.id}-hatch`, width: '8', height: '8', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, this.defs);
    el('rect', { width: '8', height: '8', fill: '#ffffff', 'fill-opacity': '0.45' }, hatch);
    el('line', { x1: '0', y1: '0', x2: '0', y2: '8', stroke: '#ffffff', 'stroke-width': '3', 'stroke-opacity': '0.7' }, hatch);
    const shadow = el('filter', { id: `${this.id}-shadow`, x: '-20%', y: '-20%', width: '140%', height: '140%' }, this.defs);
    el('feDropShadow', { dx: '0', dy: '8', stdDeviation: '10', 'flood-color': '#053B40', 'flood-opacity': '0.25' }, shadow);
    const hubShadow = el('filter', { id: `${this.id}-hub`, x: '-30%', y: '-30%', width: '160%', height: '160%' }, this.defs);
    el('feDropShadow', { dx: '0', dy: '2', stdDeviation: '3', 'flood-color': '#053B40', 'flood-opacity': '0.3' }, hubShadow);
    const hubClip = el('clipPath', { id: `${this.id}-hubclip` }, this.defs);
    el('circle', { r: 29 }, hubClip);
    this.styleDefs = el('g', {}, this.defs); // gradients that depend on the style

    this.back = el('g', {}, this.svg); // rim / edge
    this.rotor = el('g', { class: 'wheel-rotor' }, this.svg);
    this.segLayer = el('g', {}, this.rotor);
    this.shineLayer = el('g', { 'pointer-events': 'none' }, this.rotor);
    this.front = el('g', { 'aria-hidden': 'true' }, this.svg); // bulbs, hub, pointer

    this.buildFrame();
    stage.appendChild(this.svg);
  }

  get rSeg() {
    return this.style.rim ? R_OUTER - this.style.rim : R_OUTER - 2;
  }

  /** Switch to another style preset (id or object) and redraw. */
  setStyle(style) {
    this.style = typeof style === 'string' || !style ? getStyle(style) : style;
    this.buildFrame();
    if (this.segments.length) this.setSegments(this.segments);
  }

  buildFrame() {
    const st = this.style;
    const rSeg = this.rSeg;
    this.styleDefs.replaceChildren();
    this.back.replaceChildren();
    this.shineLayer.replaceChildren();
    this.front.replaceChildren();
    this.stage.dataset.wheelStyle = st.id;

    // Rim (or a thin edge for flat styles)
    if (st.rim) {
      const stops = st.rimColors?.length ? st.rimColors : ['#06636B'];
      const grad = el('linearGradient', { id: `${this.id}-rim`, x1: '0', y1: '0', x2: '1', y2: '1' }, this.styleDefs);
      stops.forEach((c, i) => el('stop', { offset: stops.length === 1 ? '0' : String(i / (stops.length - 1)), 'stop-color': c }, grad));
      el('circle', { r: R_OUTER, fill: `url(#${this.id}-rim)`, filter: `url(#${this.id}-shadow)` }, this.back);
      el('circle', { r: rSeg + st.edgeWidth / 2, fill: st.edge }, this.back);
    } else {
      el('circle', { r: rSeg + 2, fill: st.edge, filter: `url(#${this.id}-shadow)` }, this.back);
    }

    if (st.shine) {
      const shine = el('radialGradient', { id: `${this.id}-shine`, cx: '0.5', cy: '0.5', r: '0.5' }, this.styleDefs);
      el('stop', { offset: '0.55', 'stop-color': '#fff', 'stop-opacity': '0' }, shine);
      el('stop', { offset: '0.92', 'stop-color': '#fff', 'stop-opacity': '0.1' }, shine);
      el('stop', { offset: '1', 'stop-color': '#053B40', 'stop-opacity': '0.18' }, shine);
      el('circle', { r: rSeg, fill: `url(#${this.id}-shine)` }, this.shineLayer);
    }

    // Lights around the rim (they twinkle while spinning)
    if (st.bulbs && st.rim) {
      const r = R_OUTER - st.rim / 2;
      for (let i = 0; i < 24; i++) {
        const [x, y] = polar(r, i * 15 + 7.5);
        const b = el('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: Math.min(3.8, st.rim / 3.4).toFixed(2), class: `wheel-bulb${i % 2 ? ' alt' : ''}` }, this.front);
        b.style.setProperty('--bulb', st.bulbs[i % 2]);
        b.style.setProperty('--bulb-on', st.bulbs[(i + 1) % 2]);
      }
    }

    // Hub with the PharmKulen icon
    const hub = el('g', { class: 'wheel-hub' }, this.front);
    el('circle', { r: R_HUB, fill: st.hubFill, filter: `url(#${this.id}-hub)`, ...(st.hubRing ? { stroke: st.hubRing, 'stroke-width': '3' } : {}) }, hub);
    el('circle', { r: 30, fill: '#FFFFFF' }, hub);
    el('image', { href: this.iconSrc ?? brandIcon(), ...(this.iconSrc ? {} : { 'data-brand': 'icon' }), x: -31, y: -31, width: 62, height: 62, preserveAspectRatio: 'xMidYMid meet', 'clip-path': `url(#${this.id}-hubclip)` }, hub);

    // Pointer
    this.pointer = el('g', { class: 'wheel-pointer' }, this.front);
    const tip = -(rSeg - 20);
    const common = { fill: st.pointerColor, stroke: '#ffffff', 'stroke-width': '3', 'stroke-linejoin': 'round' };
    if (st.pointer === 'pin') {
      el('path', { d: `M 0 ${tip} L -15 -186 A 17 17 0 1 1 15 -186 Z`, ...common }, this.pointer);
      el('circle', { cx: 0, cy: -195, r: 6, fill: st.hubRing ?? '#FFFFFF' }, this.pointer);
    } else if (st.pointer === 'triangle') {
      el('path', { d: `M -17 -213 L 17 -213 L 0 ${tip} Z`, ...common }, this.pointer);
    } else {
      el('path', { d: `M -17 -212 Q 0 -218 17 -212 L 2.5 ${tip - 2} Q 0 ${tip + 2} -2.5 ${tip - 2} Z`, ...common }, this.pointer);
    }
  }

  setSegments(segments) {
    const st = this.style;
    const rSeg = this.rSeg;
    const labelX = rSeg - 16; // labels end just inside the rim
    this.segments = segments;
    this.colors = resolveColors(st, segments);
    this.segLayer.replaceChildren();
    this.segEls = [];
    const n = segments.length;
    if (!n) return;
    const span = 360 / n;
    const fontBase = (n <= 4 ? 30 : n <= 6 ? 26 : n <= 8 ? 23 : n <= 12 ? 18 : 14) * (rSeg / 196);
    const charW = st.uppercase ? 0.64 : 0.56;

    segments.forEach((seg, i) => {
      const fill = this.colors[i];
      const a0 = i * span;
      const g = el('g', { class: 'wheel-segment' }, this.segLayer);
      el('path', { d: arcPath(rSeg, a0, a0 + span), fill, stroke: st.edge, 'stroke-width': String(st.edgeWidth), 'stroke-linejoin': 'round' }, g);
      if (seg.available === false) {
        el('path', { d: arcPath(rSeg, a0, a0 + span), fill: `url(#${this.id}-hatch)` }, g);
      }

      const labelGroup = el('g', { transform: `rotate(${a0 + span / 2})` }, g);

      // Optional picture near the rim; the label then sits between it and the hub.
      let labelEnd = labelX;
      if (seg.image) {
        const halfRad = (span / 2) * (Math.PI / 180);
        let size = Math.min(54, 2 * 150 * Math.sin(Math.min(halfRad, Math.PI / 2)) * 0.62);
        size = Math.max(size, 22);
        const cy = -(rSeg - 12 - size / 2);
        // The picture shows whole: straight on the segment, or on a disc in its background colour.
        let pic = size;
        if (seg.imageBg) {
          el('circle', { cx: 0, cy, r: size / 2 + 2.5, fill: seg.imageBg }, labelGroup);
          pic = size * 0.78;
        }
        el('image', {
          href: seg.image, x: -pic / 2, y: cy - pic / 2, width: pic, height: pic,
          preserveAspectRatio: 'xMidYMid meet',
          opacity: seg.available === false ? '0.45' : '1',
        }, labelGroup);
        labelEnd = rSeg - 12 - size - 8;
      }

      const text0 = st.uppercase ? seg.label.toUpperCase() : seg.label;
      const lines = wrapLabel(text0);
      const longest = Math.max(...lines.map((l) => l.length));
      const arcAtMid = ((Math.PI * 2 * (seg.image ? 95 : 120)) / n) * 0.8; // usable tangential space
      let fs = Math.min(fontBase, (labelEnd - R_HUB - 10) / (longest * charW));
      fs = Math.min(fs, arcAtMid / (lines.length * 1.15));
      fs = Math.max(fs, 8);

      let color = INK;
      let halo = '';
      if (seg.available !== false) {
        if (st.labelColor === 'auto') {
          const pick = labelColorFor(fill);
          color = pick.color;
          if (pick.needsHalo) halo = ' is-light';
        } else {
          color = st.labelColor;
          if (contrast(color, fill) < 3) halo = luminance(color) > luminance(fill) ? ' is-light' : ' is-dark';
        }
      }
      const text = el('text', {
        transform: 'rotate(-90)',
        x: String(labelEnd),
        y: '0',
        'text-anchor': 'end',
        'dominant-baseline': 'central',
        'font-size': fs.toFixed(1),
        'font-weight': String(st.fontWeight ?? 700),
        'letter-spacing': st.uppercase ? '0.04em' : '0.005em',
        fill: color,
        class: `wheel-label${halo}`,
      }, labelGroup);
      lines.forEach((line, li) => {
        const t = el('tspan', { x: String(labelEnd), dy: li === 0 ? `${(-(lines.length - 1) * 0.55).toFixed(2)}em` : '1.1em' }, text);
        t.textContent = line;
      });
      if (seg.available === false) {
        // Small note on its own line beside the label, e.g. "All claimed".
        const sub = el('text', {
          transform: 'rotate(-90)', x: String(labelEnd), y: (fs * (lines.length * 0.55 + 0.55)).toFixed(1),
          'text-anchor': 'end', 'dominant-baseline': 'central', fill: INK, class: 'wheel-label wheel-sublabel',
        }, labelGroup);
        sub.textContent = unavailableNote(seg);
      }
      this.segEls.push(g);
    });

    const names = segments.map((s) => s.label + (s.available === false ? ` (${unavailableNote(s).toLowerCase()})` : '')).join(', ');
    this.svg.setAttribute('aria-label', `${this.label} with ${n} segments: ${names}.`);
    this.applyRotation();
  }

  applyRotation() {
    this.rotor.setAttribute('transform', `rotate(${this.rotation % 360})`);
  }

  /** Index of the segment currently under the pointer. */
  indexAtPointer(rotation = this.rotation) {
    const n = this.segments.length;
    if (!n) return -1;
    const local = (((-rotation) % 360) + 360) % 360;
    return Math.floor(local / (360 / n)) % n;
  }

  highlight(index) {
    this.segEls?.forEach((g, i) => g.classList.toggle('is-winner', i === index));
  }

  setClosed(closed) {
    this.stage.classList.toggle('is-closed', closed);
  }

  /** Animate so `index` stops under the pointer. Resolves when finished. */
  spinTo(index, { duration = 5600, turns = 6, reducedMotion = false } = {}) {
    if (this.spinning || index < 0 || index >= this.segments.length) return Promise.resolve();
    this.highlight(-1);
    const n = this.segments.length;
    const span = 360 / n;
    // Land somewhere inside the segment, not always dead centre (but clear of the edges).
    const jitter = (Math.random() - 0.5) * span * 0.6;
    const targetLocal = index * span + span / 2 + jitter;
    const start = this.rotation;
    const base = ((-targetLocal - start) % 360 + 360) % 360;
    const end = start + base + (reducedMotion ? 1 : turns) * 360;
    const total = reducedMotion ? Math.min(duration, 1200) : duration;

    this.spinning = true;
    this.stage.classList.add('is-spinning');
    let lastIdx = this.indexAtPointer(start);
    const t0 = performance.now();

    return new Promise((resolve) => {
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / total);
        this.rotation = start + (end - start) * easeOut(t);
        this.applyRotation();
        const idx = this.indexAtPointer();
        if (idx !== lastIdx) {
          lastIdx = idx;
          this.tick();
        }
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          this.rotation = end % 360;
          this.applyRotation();
          this.spinning = false;
          this.stage.classList.remove('is-spinning');
          this.highlight(index);
          resolve();
        }
      };
      requestAnimationFrame(frame);
    });
  }

  tick() {
    this.pointer.classList.add('tick');
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => this.pointer.classList.remove('tick'), 50);
    this.onTick?.();
  }
}
