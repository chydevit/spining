// Core game rules: config validation, availability, odds and the weighted draw.
import crypto from 'node:crypto';
import { STYLE_IDS, DEFAULT_STYLE } from '../public/js/styles.js';

export const LIMITS = {
  minSegments: 2,
  maxSegments: 16,
  labelMax: 24,
  descriptionMax: 140,
  weightMax: 1000,
  quantityMax: 100000,
  titleMax: 40,
  taglineMax: 140,
  instructionMax: 160,
  instructionsMax: 6,
  buttonMax: 16,
  disclaimerMax: 300,
  closedMessageMax: 160,
  spinsPerDayMax: 100,
};

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9-]{1,40}$/i;
const IMAGE_URL = /^\/uploads\/[a-f0-9]{24}\.(png|jpg|webp)$/;

function brandImage(value, what, errors) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && IMAGE_URL.test(value)) return value;
  errors.push(`The ${what} image is not valid. Upload it again.`);
  return null;
}

function str(value, { field, max, min = 0, errors }) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < min) errors.push(min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`);
  if (s.length > max) errors.push(`${field} must be ${max} characters or fewer.`);
  return s.slice(0, max);
}

function parseDate(value, field, errors) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    errors.push(`${field} is not a valid date.`);
    return null;
  }
  return d.toISOString();
}

/** Validate and normalise an admin-submitted config. Returns { config, errors }. */
export function validateConfig(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { config: null, errors: ['Invalid configuration payload.'] };

  const b = input.branding ?? {};
  const instructionsIn = Array.isArray(b.instructions) ? b.instructions : [];
  const instructions = instructionsIn
    .map((line, i) => str(line, { field: `Instruction ${i + 1}`, max: LIMITS.instructionMax, errors }))
    .filter(Boolean);
  if (instructions.length === 0) errors.push('Add at least one instruction for players.');
  if (instructions.length > LIMITS.instructionsMax) errors.push(`Use ${LIMITS.instructionsMax} instructions or fewer.`);

  const branding = {
    title: str(b.title, { field: 'Game title', max: LIMITS.titleMax, min: 1, errors }),
    tagline: str(b.tagline, { field: 'Tagline', max: LIMITS.taglineMax, errors }),
    instructions: instructions.slice(0, LIMITS.instructionsMax),
    spinButtonLabel: str(b.spinButtonLabel, { field: 'Spin button label', max: LIMITS.buttonMax, min: 1, errors }),
    disclaimer: str(b.disclaimer, { field: 'Disclaimer', max: LIMITS.disclaimerMax, errors }),
    // Uploaded logo (wide, top bar) and icon (square mark); null = the PharmKulen originals.
    logo: brandImage(b.logo, 'logo', errors),
    icon: brandImage(b.icon, 'icon', errors),
  };

  const a = input.availability ?? {};
  const spinsPerDay = Number(a.spinsPerDevicePerDay ?? 0);
  if (!Number.isInteger(spinsPerDay) || spinsPerDay < 0 || spinsPerDay > LIMITS.spinsPerDayMax) {
    errors.push(`Spins per player must be a whole number from 0 to ${LIMITS.spinsPerDayMax}.`);
  }
  const availability = {
    enabled: a.enabled === true,
    closedMessage: str(a.closedMessage, { field: 'Closed message', max: LIMITS.closedMessageMax, errors }),
    startAt: parseDate(a.startAt, 'Start time', errors),
    endAt: parseDate(a.endAt, 'End time', errors),
    // (name kept for compatibility; it is "spins per player")
    spinsPerDevicePerDay: Number.isInteger(spinsPerDay) ? Math.max(0, Math.min(spinsPerDay, LIMITS.spinsPerDayMax)) : 0,
    // 'day' = the allowance resets every day; 'total' = for the whole game
    limitPeriod: a.limitPeriod === 'total' ? 'total' : 'day',
  };
  if (availability.startAt && availability.endAt && availability.endAt <= availability.startAt) {
    errors.push('End time must be after the start time.');
  }

  const segIn = Array.isArray(input.segments) ? input.segments : [];
  if (segIn.length < LIMITS.minSegments) errors.push(`The wheel needs at least ${LIMITS.minSegments} segments.`);
  if (segIn.length > LIMITS.maxSegments) errors.push(`The wheel can have at most ${LIMITS.maxSegments} segments.`);

  const seenIds = new Set();
  const segments = segIn.slice(0, LIMITS.maxSegments).map((s, i) => {
    const n = i + 1;
    s = s ?? {};
    let id = typeof s.id === 'string' && ID.test(s.id) ? s.id : `seg-${crypto.randomBytes(4).toString('hex')}`;
    if (seenIds.has(id)) id = `seg-${crypto.randomBytes(4).toString('hex')}`;
    seenIds.add(id);

    const weight = Number(s.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > LIMITS.weightMax) {
      errors.push(`Segment ${n}: weight must be a number from 0 to ${LIMITS.weightMax}.`);
    }
    let quantity = null;
    if (s.quantity !== null && s.quantity !== undefined && s.quantity !== '') {
      quantity = Number(s.quantity);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > LIMITS.quantityMax) {
        errors.push(`Segment ${n}: quantity must be a whole number from 0 to ${LIMITS.quantityMax}, or left blank for unlimited.`);
        quantity = 0;
      }
    }
    if (!HEX.test(s.color ?? '')) errors.push(`Segment ${n}: choose a valid colour.`);
    if (s.image && !IMAGE_URL.test(String(s.image))) errors.push(`Segment ${n}: the image is not valid. Upload it again.`);

    return {
      id,
      label: str(s.label, { field: `Segment ${n} label`, max: LIMITS.labelMax, min: 1, errors }),
      description: str(s.description, { field: `Segment ${n} description`, max: LIMITS.descriptionMax, errors }),
      color: HEX.test(s.color ?? '') ? s.color.toUpperCase() : '#058F9A',
      weight: Number.isFinite(weight) ? Math.round(Math.max(0, Math.min(weight, LIMITS.weightMax)) * 100) / 100 : 0,
      quantity,
      isPrize: s.isPrize === true,
      image: typeof s.image === 'string' && IMAGE_URL.test(s.image) ? s.image : null,
      imageBg: HEX.test(s.imageBg ?? '') ? s.imageBg.toUpperCase() : null, // colour behind the picture; null = none
      hidden: s.hidden === true, // kept with its settings and stock, but left off the wheel
    };
  });

  if (segments.length && !segments.some((s) => s.weight > 0 && !s.hidden)) {
    errors.push('At least one segment that isn’t hidden needs a weight above 0 so the wheel can land somewhere.');
  }

  return {
    config: {
      branding,
      availability,
      showOdds: input.showOdds === true,
      hideUnavailable: input.hideUnavailable === true, // leave out-of-stock / switched-off gifts off the wheel
      collectDetails: input.collectDetails !== false,
      wheelStyle: STYLE_IDS.includes(input.wheelStyle) ? input.wheelStyle : DEFAULT_STYLE,
      segments,
    },
    errors,
  };
}

export function isSegmentAvailable(segment) {
  return !segment.hidden && segment.weight > 0 && (segment.quantity === null || segment.quantity > 0);
}

/** Probability (0..1) of landing on each segment, in segment order. */
export function computeOdds(segments) {
  const total = segments.reduce((sum, s) => sum + (isSegmentAvailable(s) ? s.weight : 0), 0);
  return segments.map((s) => (total > 0 && isSegmentAvailable(s) ? s.weight / total : 0));
}

/** Is the game open right now? Returns { open, reason, message, startAt?, endAt? }. */
export function availabilityStatus(config, now = new Date()) {
  const a = config.availability;
  const closed = (reason) => ({ open: false, reason, message: a.closedMessage || 'The game is currently closed.' });
  if (!a.enabled) return closed('disabled');
  if (a.startAt && now < new Date(a.startAt)) return { ...closed('not-started'), startAt: a.startAt };
  if (a.endAt && now >= new Date(a.endAt)) return { ...closed('ended'), endAt: a.endAt };
  if (!config.segments.some(isSegmentAvailable)) return closed('no-outcomes');
  return { open: true, reason: null, message: null, endAt: a.endAt };
}

/** Pick a segment index using weights. `rand(max)` returns an integer in [0, max). */
export function drawSegment(segments, rand = (max) => crypto.randomInt(max)) {
  // Weights may have two decimals; scale to integers for an exact, unbiased draw.
  const scaled = segments.map((s) => (isSegmentAvailable(s) ? Math.round(s.weight * 100) : 0));
  const total = scaled.reduce((a, b) => a + b, 0);
  if (total <= 0) return -1;
  let r = rand(total);
  for (let i = 0; i < scaled.length; i++) {
    if (r < scaled[i]) return i;
    r -= scaled[i];
  }
  return -1;
}

export function claimCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return `PK-${code}`;
}

/** Local calendar day (YYYY-MM-DD) in the server's time zone. */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Validate the name + phone a player enters before spinning.
 * Returns { player: { name, phone }, errors: { name?, phone? } }.
 */
export function validatePlayer(input = {}) {
  const errors = {};
  const name = String(input.name ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2) errors.name = 'Please enter your name.';
  else if (name.length > 60) errors.name = 'Please use 60 characters or fewer for your name.';

  const rawPhone = String(input.phone ?? '').trim();
  // Keep a leading + for international numbers; drop spaces, dashes, dots and brackets.
  const phone = rawPhone.replace(/[\s\-.()]/g, '');
  if (!phone) errors.phone = 'Please enter your phone number.';
  else if (!/^\+?\d{6,15}$/.test(phone)) errors.phone = 'Please enter a valid phone number (digits only, e.g. 012 345 678).';

  return { player: { name, phone }, errors };
}
