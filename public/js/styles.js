// Wheel style presets. Shared by the player game, the admin console and the
// server (which only needs the ids for validation), so keep this file DOM-free.
//
// palette: null           → use each segment's own colour (set in Admin → Wheel & gifts)
//          [hex, ...]     → colours repeat around the wheel
//          { gradient }   → colours blend from the first to the last stop around the wheel
export const WHEEL_STYLES = [
  {
    id: 'classic',
    name: 'Classic',
    note: 'Flat and bright with your own segment colours.',
    palette: null,
    rim: 0,
    edge: '#FFFFFF',
    edgeWidth: 1.5,
    pointer: 'arrow',
    pointerColor: '#06636B',
    hubFill: '#FFFFFF',
    labelColor: 'auto',
    fontWeight: 700,
    glow: null,
  },
  {
    id: 'carnival',
    name: 'Carnival lights',
    note: 'Deep teal rim with twinkling lights while it spins.',
    palette: null,
    rim: 14,
    rimColors: ['#0A9FA9', '#06636B', '#053B40'],
    bulbs: ['#FFFFFF', '#44E4BC'],
    edge: '#FFFFFF',
    edgeWidth: 2,
    pointer: 'pin',
    pointerColor: '#06757E',
    hubFill: '#FFFFFF',
    hubRing: '#44E4BC',
    labelColor: 'auto',
    fontWeight: 800,
    shine: true,
    glow: '#44E4BC',
  },
  {
    id: 'pastel',
    name: 'Soft pastel',
    note: 'Gentle tints of the PharmKulen colours with a white frame.',
    palette: ['#C9EEFF', '#CFF6EA', '#B7E6FF', '#C3F1E3', '#DDF3F4', '#ADE3F5'],
    extra: '#E6F7EF',
    rim: 8,
    rimColors: ['#FFFFFF'],
    edge: '#FFFFFF',
    edgeWidth: 4,
    pointer: 'triangle',
    pointerColor: '#0B7F8A',
    hubFill: '#FFFFFF',
    hubRing: '#BDEBE0',
    labelColor: '#0B3B40',
    fontWeight: 700,
    glow: '#A6E9DB',
  },
  {
    id: 'mint',
    name: 'Pharmacy mint',
    note: 'Clean white and mint, like a fresh pharmacy counter.',
    palette: ['#FFFFFF', '#D9F6EE'],
    extra: '#BFEDE1',
    rim: 8,
    rimColors: ['#11BD9B', '#0A9C80'],
    edge: '#9FDCCD',
    edgeWidth: 1.5,
    pointer: 'pin',
    pointerColor: '#11BD9B',
    hubFill: '#FFFFFF',
    hubRing: '#11BD9B',
    labelColor: '#06636B',
    fontWeight: 800,
    glow: '#11BD9B',
  },
  {
    id: 'ocean',
    name: 'Ocean blend',
    note: 'Bright blue flowing into green all the way round.',
    palette: { gradient: ['#19B2FF', '#058F9A', '#11BD9B'] },
    rim: 0,
    edge: '#FFFFFF',
    edgeWidth: 1,
    pointer: 'arrow',
    pointerColor: '#053B40',
    hubFill: '#FFFFFF',
    labelColor: 'auto',
    fontWeight: 700,
    glow: '#19B2FF',
  },
  {
    id: 'teal',
    name: 'Teal tones',
    note: 'Shades of PharmKulen teal for a calm, premium look.',
    palette: ['#058F9A', '#06636B', '#0A9FA9', '#075A61'],
    rim: 6,
    rimColors: ['#053B40'],
    edge: '#7FE3D0',
    edgeWidth: 1,
    pointer: 'arrow',
    pointerColor: '#44E4BC',
    hubFill: '#FFFFFF',
    hubRing: '#7FE3D0',
    labelColor: '#FFFFFF',
    fontWeight: 700,
    glow: '#058F9A',
  },
  {
    id: 'midnight',
    name: 'Midnight glow',
    note: 'Dark wheel with glowing turquoise letters and lights.',
    palette: ['#053B40', '#0A4D57', '#06636B', '#0B3A52'],
    rim: 10,
    rimColors: ['#021E22'],
    bulbs: ['#44E4BC', '#19B2FF'],
    edge: '#44E4BC',
    edgeWidth: 1,
    pointer: 'arrow',
    pointerColor: '#44E4BC',
    hubFill: '#0B2A2F',
    hubRing: '#44E4BC',
    labelColor: '#7FF0D6',
    fontWeight: 700,
    uppercase: true,
    glow: '#19B2FF',
  },
  {
    id: 'celebration',
    name: 'Gold celebration',
    note: 'Teal and gold with a golden rim, great for festivals.',
    palette: ['#06636B', '#F2B33D'],
    extra: '#11BD9B',
    rim: 12,
    rimColors: ['#F7D27A', '#E0A12A', '#B57A0E'],
    bulbs: ['#FFFFFF', '#FFE7A3'],
    edge: '#FFF4D6',
    edgeWidth: 1.5,
    pointer: 'pin',
    pointerColor: '#B57A0E',
    hubFill: '#FFFFFF',
    hubRing: '#F2B33D',
    labelColor: 'auto',
    fontWeight: 800,
    uppercase: true,
    shine: true,
    glow: '#F2B33D',
  },
  {
    id: 'festival',
    name: 'Festival',
    note: 'Red, orange, green and blue — the classic party wheel.',
    palette: ['#E53935', '#FB8C00', '#43A047', '#1E88E5'],
    rim: 0,
    edge: '#FFFFFF',
    edgeWidth: 1.5,
    pointer: 'arrow',
    pointerColor: '#C62828',
    hubFill: '#FFFFFF',
    labelColor: 'auto',
    fontWeight: 600,
    glow: '#FB8C00',
  },
  {
    id: 'slots',
    kind: 'slot', // drawn as a 3-reel slot machine instead of a wheel (see slot.js)
    name: 'Lucky slots',
    note: 'An arcade slot machine with three reels, a pull lever and a gift panel.',
    palette: null,
    glow: '#44E4BC',
  },
  {
    id: 'capsule',
    kind: 'capsule', // a toy capsule (gacha) machine (see capsule.js)
    name: 'Capsule machine',
    note: 'Turn the knob and a capsule drops out and pops open with the gift inside.',
    palette: null,
    glow: '#19B2FF',
  },
  {
    id: 'plinko',
    kind: 'plinko', // a pachinko / Plinko drop board (see plinko.js)
    name: 'Lucky drop',
    note: 'A ball shoots up, bounces down through PharmKulen pins and lands in a gift slot.',
    palette: null,
    glow: '#F7D27A',
  },
  {
    id: 'claw',
    kind: 'claw', // a crane / claw machine (see claw.js)
    name: 'Claw machine',
    note: 'The claw slides over, grabs a gift box and drops it in the prize chute.',
    palette: null,
    glow: '#7FD6C4',
  },
];

export const STYLE_IDS = WHEEL_STYLES.map((s) => s.id);
export const DEFAULT_STYLE = 'classic';

export function getStyle(id) {
  return WHEEL_STYLES.find((s) => s.id === id) ?? WHEEL_STYLES[0];
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift) => Math.round(((pa >> shift) & 255) + ((((pb >> shift) & 255) - ((pa >> shift) & 255)) * t));
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** The colour each segment is actually drawn in under a style. */
export function resolveColors(style, segments) {
  const n = segments.length;
  const p = style.palette;
  if (!p) return segments.map((s) => s.color);
  if (Array.isArray(p)) {
    const out = segments.map((_, i) => p[i % p.length]);
    // Avoid two equal colours meeting where the wheel wraps around.
    if (n > 1 && out[n - 1] === out[0]) out[n - 1] = style.extra ?? p[Math.min(1, p.length - 1)];
    return out;
  }
  // Gradient: go out along the stops and back, so the wrap-around is seamless.
  const stops = p.gradient;
  return segments.map((_, i) => {
    const t = n <= 1 ? 0 : 1 - Math.abs(1 - (2 * i) / n); // 0 → 1 → 0
    const pos = t * (stops.length - 1);
    const k = Math.min(Math.floor(pos), stops.length - 2);
    return mix(stops[k], stops[k + 1], pos - k);
  });
}
