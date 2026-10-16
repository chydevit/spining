// PharmKulen Spin — admin console.
import { Spinner } from './spinner.js';
import { setBrand, DEFAULT_LOGO, DEFAULT_ICON } from './brand.js';
import { WHEEL_STYLES, getStyle, resolveColors } from './styles.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const PALETTE = [
  { name: 'Bright blue', hex: '#19B2FF' },
  { name: 'Sky', hex: '#62DBFF' },
  { name: 'Turquoise', hex: '#44E4BC' },
  { name: 'Green', hex: '#11BD9B' },
  { name: 'Teal', hex: '#058F9A' },
  { name: 'Deep teal', hex: '#06636B' },
];
const MAX_SEGMENTS = 16;
const MIN_SEGMENTS = 2;
const MONEY_WORDS = /\$|៛|€|£|\b(usd|khr|riels?|dollars?|cash|money|jackpot|guarantee[ds]?)\b/i;
const TABS = ['dashboard', 'wheel', 'style', 'availability', 'branding', 'security'];
const PREVIEW_TABS = new Set(['wheel', 'style', 'availability', 'branding']);

const state = {
  server: null, // last saved config
  version: null,
  draft: null, // working copy
  loadedQty: new Map(), // stock values when the draft was loaded (see server merge logic)
  stats: null,
  searchQ: '',
  day: '', // YYYY-MM-DD filter for Recent spins ('' = all days)
  tab: 'dashboard',
  saving: false,
};

const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function toast(message, kind = 'success') {
  const icon = kind === 'error'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' });
  t.innerHTML = icon;
  t.append(h('span', { text: message }));
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

class ApiError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new ApiError('Could not reach the server. Check your connection.'), { status: 0, data: {} });
  }
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && path !== '/api/admin/login') {
    showLogin('Your session ended. Sign in again — your unsaved changes are kept.');
  }
  if (!res.ok) throw Object.assign(new ApiError(data.error || `Request failed (${res.status}).`), { status: res.status, data });
  return data;
}

// ---------- formatting ----------
const fmtInt = (n) => new Intl.NumberFormat().format(n);
function fmtPct(p) {
  if (!p) return '0%';
  if (p < 0.001) return '<0.1%';
  return `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
}
function fmtTime(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return 'seg-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- game rules mirrored for preview ----------
const segAvailable = (s) => !s.hidden && Number(s.weight) > 0 && (s.quantity === null || Number(s.quantity) > 0);
function odds(segments) {
  const total = segments.reduce((sum, s) => sum + (segAvailable(s) ? Number(s.weight) : 0), 0);
  return segments.map((s) => (total > 0 && segAvailable(s) ? Number(s.weight) / total : 0));
}
function draftStatus(config, now = new Date()) {
  const a = config.availability;
  if (!a.enabled) return { open: false, text: 'Closed — switched off' };
  if (a.startAt && now < new Date(a.startAt)) return { open: false, text: `Closed — opens ${fmtTime(a.startAt)}` };
  if (a.endAt && now >= new Date(a.endAt)) return { open: false, text: `Closed — ended ${fmtTime(a.endAt)}` };
  if (!config.segments.some(segAvailable)) return { open: false, text: 'Closed — no outcomes available' };
  return { open: true, text: a.endAt ? `Open until ${fmtTime(a.endAt)}` : 'Open' };
}

// ================= Auth =================
function showLogin(notice) {
  stopAutoRefresh();
  $('app-view').hidden = true;
  $('header-actions').hidden = true;
  $('login-view').hidden = false;
  $('login-notice').hidden = !notice;
  $('login-notice').textContent = notice ?? '';
  $('login-error').textContent = '';
  $('login-password').value = '';
  $('login-password').focus();
}

async function enterApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('header-actions').hidden = false;
  if (!state.draft) await loadConfig();
  selectTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard', { focus: false });
  loadStats();
  startAutoRefresh();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('login-password');
  const err = $('login-error');
  const btn = $('login-submit');
  err.textContent = '';
  pw.removeAttribute('aria-invalid');
  if (!pw.value) {
    err.textContent = 'Enter the admin password.';
    pw.setAttribute('aria-invalid', 'true');
    pw.focus();
    return;
  }
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Signing in…');
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
    pw.value = '';
    await enterApp();
    toast('Signed in.');
  } catch (ex) {
    err.textContent = ex.message;
    pw.setAttribute('aria-invalid', 'true');
    pw.select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

document.querySelectorAll('[data-reveal]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.reveal);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
});

$('logout-btn').addEventListener('click', async () => {
  if (isDirty()) {
    const ok = await confirmDialog({
      title: 'Sign out without saving?',
      body: 'You have unsaved changes. They will be lost if you sign out now.',
      confirmLabel: 'Sign out anyway',
    });
    if (!ok) return;
  }
  try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  state.draft = null;
  state.server = null;
  updateDirty();
  showLogin('You have signed out.');
});

// ================= Tabs =================
const tabButtons = [...document.querySelectorAll('[role="tab"]')];

function selectTab(name, { focus = true } = {}) {
  state.tab = name;
  for (const btn of tabButtons) {
    const active = btn.dataset.tab === name;
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    $(btn.getAttribute('aria-controls')).hidden = !active;
    if (active && focus) btn.focus();
  }
  const withPreview = PREVIEW_TABS.has(name);
  $('preview').hidden = !withPreview;
  document.querySelector('.workspace').classList.toggle('with-preview', withPreview);
  history.replaceState(null, '', `#${name}`);
  if (name === 'dashboard') loadStats();
  if (withPreview) schedulePreview();
}

tabButtons.forEach((btn, i) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab, { focus: false }));
  btn.addEventListener('keydown', (e) => {
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabButtons.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + tabButtons.length) % tabButtons.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabButtons.length - 1;
    if (next !== null) {
      e.preventDefault();
      selectTab(tabButtons[next].dataset.tab);
    }
  });
});

// ================= Config: load / dirty / save =================
async function loadConfig() {
  const res = await api('/api/admin/config');
  setServerConfig(res);
}

function setServerConfig(res) {
  state.server = res.config;
  state.version = res.version;
  state.draft = clone(res.config);
  state.loadedQty = new Map(res.config.segments.map((s) => [s.id, s.quantity]));
  renderConfigForms();
  updateDirty();
}

function isDirty() {
  return !!state.draft && JSON.stringify(state.draft) !== JSON.stringify(state.server);
}

let savedTimer;
function updateDirty() {
  const dirty = isDirty();
  const bar = $('save-bar');
  clearTimeout(savedTimer);
  if (dirty) {
    bar.hidden = false;
    bar.classList.remove('is-saved');
    if (!bar.classList.contains('is-error')) $('save-status').textContent = 'You have unsaved changes.';
    $('save-btn').disabled = state.saving;
    $('save-btn').hidden = false;
    $('discard-btn').hidden = false;
  } else if (!bar.classList.contains('is-saved')) {
    bar.hidden = true;
  }
  $('preview-state').textContent = dirty ? 'Unsaved changes' : 'Saved';
  $('preview-state').className = `pill ${dirty ? 'pill-warning' : 'pill-success'}`;
  checkMoneyWords();
}

function onDraftChange() {
  $('save-bar').classList.remove('is-error');
  updateDirty();
  schedulePreview();
}

function clearErrors() {
  $('error-summary').hidden = true;
  $('error-list').replaceChildren();
}

function tabForError(message) {
  if (/^Segment|segment|wheel/.test(message)) return 'wheel';
  if (/Start time|End time|Spins per device|Closed message/.test(message)) return 'availability';
  return 'branding';
}

function showErrors(errors) {
  const names = { wheel: 'Wheel & gifts', availability: 'Availability', branding: 'Branding' };
  $('error-list').replaceChildren(...errors.map((e) => {
    const tab = tabForError(e);
    return h('li', {}, h('button', { type: 'button', onclick: () => selectTab(tab), text: `${names[tab]}: ${e}` }));
  }));
  $('error-summary').hidden = false;
  $('error-summary').focus();
}

async function save() {
  if (state.saving || !isDirty()) return;
  clearErrors();
  state.saving = true;
  const btn = $('save-btn');
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Saving…');
  $('save-status').textContent = 'Saving your changes…';
  const bar = $('save-bar');
  bar.classList.remove('is-error', 'is-saved');

  const payload = clone(state.draft);
  payload.segments.forEach((s) => {
    if (state.loadedQty.has(s.id)) s.quantityLoaded = state.loadedQty.get(s.id);
  });

  try {
    const res = await api('/api/admin/config', { method: 'PUT', body: { version: state.version, config: payload } });
    setServerConfig(res);
    bar.hidden = false;
    bar.classList.add('is-saved');
    $('save-status').textContent = 'All changes saved. Players see them right away.';
    $('discard-btn').hidden = true;
    btn.hidden = true;
    toast('Changes saved.');
    savedTimer = setTimeout(() => {
      bar.classList.remove('is-saved');
      if (!isDirty()) bar.hidden = true;
    }, 3000);
    loadStats();
  } catch (err) {
    bar.classList.add('is-error');
    if (err.status === 422 && err.data.errors) {
      $('save-status').textContent = 'Not saved — please fix the problems listed above.';
      showErrors(err.data.errors);
    } else if (err.status === 409 && err.data.conflict) {
      $('save-status').textContent = 'Not saved — settings were changed elsewhere.';
      const reload = await confirmDialog({
        title: 'Settings changed elsewhere',
        body: 'Another admin saved changes after you opened this page. Reload the latest settings? Your unsaved edits will be replaced.',
        confirmLabel: 'Reload latest',
        danger: false,
      });
      if (reload) {
        await loadConfig();
        bar.classList.remove('is-error');
        toast('Loaded the latest settings.');
      }
    } else if (err.status !== 401) {
      $('save-status').textContent = `Not saved — ${err.message}`;
      toast(err.message, 'error');
    } else {
      $('save-status').textContent = 'Not saved — sign in again, then save.';
    }
  } finally {
    state.saving = false;
    btn.textContent = 'Save changes';
    btn.disabled = !isDirty();
  }
}

$('save-btn').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !$('app-view').hidden) {
    e.preventDefault();
    save();
  }
});

$('discard-btn').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Discard unsaved changes?',
    body: 'Your edits will be reverted to the last saved settings.',
    confirmLabel: 'Discard changes',
  });
  if (!ok) return;
  state.draft = clone(state.server);
  clearErrors();
  $('save-bar').classList.remove('is-error');
  renderConfigForms();
  updateDirty();
  toast('Changes discarded.');
});

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function checkMoneyWords() {
  const box = $('money-warning');
  if (!state.draft) return (box.hidden = true);
  const hits = [];
  state.draft.segments.forEach((s, i) => {
    const m = `${s.label} ${s.description}`.match(MONEY_WORDS);
    if (m) hits.push(`segment ${i + 1} (“${m[0]}”)`);
  });
  const b = state.draft.branding;
  const m = [b.title, b.tagline, b.spinButtonLabel, ...b.instructions].join(' ').match(MONEY_WORDS);
  if (m) hits.push(`branding text (“${m[0]}”)`);
  box.hidden = hits.length === 0;
  box.textContent = hits.length
    ? `Heads up: ${hits.join(', ')} mentions money or a guarantee. Gifts should not suggest cash value or guaranteed rewards.`
    : '';
}

// ================= Wheel & gifts editor =================
function segmentHits(id) {
  return state.stats?.segments.find((s) => s.id === id)?.hits ?? 0;
}

function renderSegments() {
  const list = $('segment-list');
  const segs = state.draft.segments;
  const o = odds(segs);
  list.replaceChildren(...segs.map((s, i) => {
    const uid = `${s.id}-${i}`;
    const li = h('li', { class: `segment${s.hidden ? ' is-hidden' : ''}`, dataset: { index: i }, 'aria-label': `Segment ${i + 1}: ${s.label || 'untitled'}${s.hidden ? ' (hidden)' : ''}` });
    li.style.setProperty('--seg-color', s.color);

    const chips = PALETTE.map((p) =>
      h('button', {
        type: 'button', class: 'color-chip', 'aria-label': p.name, title: p.name,
        'aria-pressed': String(p.hex.toUpperCase() === s.color.toUpperCase()), dataset: { action: 'color', color: p.hex },
      }),
    );
    chips.forEach((c) => (c.style.background = c.dataset.color));

    const hits = segmentHits(s.id);
    li.append(
      h('span', { class: 'segment-index', 'aria-hidden': 'true', text: String(i + 1) }),
      h('div', { class: 'segment-fields' },
        s.hidden ? h('p', { class: 'segment-hidden-note', text: 'Hidden — not on the wheel and can’t be won. Its settings and stock are kept.' }) : null,
        h('div', { class: 'field f-label' },
          h('label', { for: `lbl-${uid}`, text: 'Label on wheel' }),
          h('input', { id: `lbl-${uid}`, class: 'input', maxlength: '24', value: s.label, dataset: { field: 'label' }, required: true }),
        ),
        h('div', { class: 'field f-desc' },
          h('label', { for: `desc-${uid}`, text: 'Message shown to the player' }),
          h('input', { id: `desc-${uid}`, class: 'input', maxlength: '140', value: s.description, dataset: { field: 'description' } }),
        ),
        h('div', { class: 'field f-image', role: 'group', 'aria-labelledby': `img-${uid}` },
          h('span', { id: `img-${uid}`, class: 'label', text: 'Image (optional)' }),
          h('div', { class: 'image-row' },
            segThumb(s, 'image-drop', true),
            h('div', { class: 'image-actions' },
              h('label', { class: 'btn btn-secondary btn-sm file-btn' },
                h('input', { type: 'file', class: 'visually-hidden', accept: 'image/png,image/jpeg,image/webp', dataset: { field: 'imageFile' }, 'aria-label': `${s.image ? 'Change' : 'Upload'} image for segment ${i + 1}` }),
                s.image ? 'Change' : 'Upload',
              ),
              s.image ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm delete', dataset: { action: 'remove-image' }, text: 'Remove', 'aria-label': `Remove image from segment ${i + 1}` }) : null,
            ),
          ),
          s.image ? imageBgRow(s, i) : null,
        ),
        h('div', { class: 'field f-color', role: 'group', 'aria-labelledby': `col-${uid}` },
          h('span', { id: `col-${uid}`, class: 'label', text: 'Colour' }),
          h('div', { class: 'color-row' },
            ...chips,
            h('input', { type: 'color', class: 'color-custom', value: s.color.toLowerCase(), 'aria-label': 'Custom colour', dataset: { field: 'color' } }),
          ),
        ),
        h('div', { class: 'field f-type' },
          h('span', { class: 'label', text: 'Type' }),
          h('div', { class: 'toggle-row' },
            h('label', { class: 'switch' },
              h('input', { type: 'checkbox', checked: s.isPrize, dataset: { field: 'isPrize' } }),
              h('span', { text: 'Gift' }),
            ),
          ),
        ),
        h('div', { class: 'field f-weight' },
          h('label', { for: `w-${uid}`, text: 'Weight' }),
          h('input', { id: `w-${uid}`, class: 'input', type: 'number', min: '0', max: '1000', step: 'any', inputmode: 'decimal', value: String(s.weight), dataset: { field: 'weight' }, 'aria-describedby': `ch-${uid}` }),
          h('span', { id: `ch-${uid}`, class: 'chance', dataset: { chance: i }, text: s.hidden ? 'Hidden' : `${fmtPct(o[i])} chance` }),
        ),
        h('div', { class: 'field f-stock' },
          h('label', { for: `q-${uid}`, text: 'Stock left' }),
          h('input', { id: `q-${uid}`, class: 'input', type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: 'Unlimited', value: s.quantity ?? '', dataset: { field: 'quantity' }, 'aria-describedby': `qh-${uid}` }),
          h('span', { id: `qh-${uid}`, class: 'chance', text: s.isPrize ? `${fmtInt(hits)} won so far` : (s.quantity === null ? 'Never runs out' : '') }),
        ),
        h('div', { class: 'seg-actions f-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost', dataset: { action: 'up' }, disabled: i === 0, text: '↑ Move up', 'aria-label': `Move segment ${i + 1} up` }),
          h('button', { type: 'button', class: 'btn btn-ghost', dataset: { action: 'down' }, disabled: i === segs.length - 1, text: '↓ Move down', 'aria-label': `Move segment ${i + 1} down` }),
          h('button', { type: 'button', class: 'btn btn-ghost', dataset: { action: 'hide' }, 'aria-pressed': String(s.hidden === true), text: s.hidden ? 'Show' : 'Hide', 'aria-label': `${s.hidden ? 'Show' : 'Hide'} segment ${i + 1} on the wheel` }),
          h('button', { type: 'button', class: 'btn btn-ghost', dataset: { action: 'duplicate' }, disabled: segs.length >= MAX_SEGMENTS, text: 'Duplicate', 'aria-label': `Duplicate segment ${i + 1}` }),
          h('button', { type: 'button', class: 'btn btn-ghost delete', dataset: { action: 'delete' }, disabled: segs.length <= MIN_SEGMENTS, text: 'Delete', 'aria-label': `Delete segment ${i + 1}` }),
        ),
      ),
    );
    return li;
  }));
  $('add-segment').disabled = segs.length >= MAX_SEGMENTS;
  $('segment-count').textContent = `${segs.length} of ${MAX_SEGMENTS} segments.`;
}

/** Choices for the colour behind a gift picture: none (transparent), white, the gift's colour, brand colours, or any colour. */
function imageBgRow(s, i) {
  const choices = [
    { name: 'None (transparent)', hex: '' },
    { name: 'White', hex: '#FFFFFF' },
    { name: 'Gift colour', hex: s.color.toUpperCase() },
    ...PALETTE.map((p) => ({ name: p.name, hex: p.hex.toUpperCase() })),
  ].filter((c, k, arr) => arr.findIndex((x) => x.hex === c.hex) === k);
  const current = s.imageBg ?? '';
  const chips = choices.map((c) => {
    const chip = h('button', {
      type: 'button', class: `color-chip bg-chip${c.hex ? '' : ' bg-none'}`, title: c.name, 'aria-label': `Picture background: ${c.name}`,
      'aria-pressed': String(c.hex === current), dataset: { action: 'image-bg', bg: c.hex },
    });
    if (c.hex) chip.style.background = c.hex;
    return chip;
  });
  return h('div', { class: 'image-bg', role: 'group', 'aria-label': `Picture background for segment ${i + 1}` },
    h('span', { class: 'image-bg-label', text: 'Picture background' }),
    h('div', { class: 'color-row' },
      ...chips,
      h('input', { type: 'color', class: 'color-custom', value: (s.imageBg ?? '#FFFFFF').toLowerCase(), 'aria-label': 'Custom picture background colour', dataset: { field: 'imageBg' } }),
    ),
  );
}

/** Square thumbnail: the uploaded image on its picture background (checkerboard = none), or the segment colour. */
function segThumb(s, extraClass = '', large = false) {
  const box = h('span', { class: `thumb ${extraClass}${large ? ' thumb-lg' : ''}`, 'aria-hidden': 'true' });
  box.style.background = s.color;
  if (s.image) {
    box.classList.add('has-image', s.imageBg ? 'has-bg' : 'is-transparent');
    box.style.setProperty('--thumb-bg', s.imageBg ?? 'transparent');
    box.append(h('img', { src: s.image, alt: '' }));
  } else if (large) {
    box.append(h('span', { class: 'thumb-empty', text: 'No image' }));
  }
  return box;
}

// ----- Segment images -----
const MAX_SOURCE_IMAGE = 15 * 1024 * 1024;

/** Downscale to at most 320px and re-encode, which also strips photo metadata. */
async function prepareImage(file, maxSize = 320) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > MAX_SOURCE_IMAGE) throw new Error('That image is too large. Please choose one under 15 MB.');
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('That image could not be read. Try another file.'); }
  const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  let blob = await toBlob('image/webp', 0.86);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/png');
  return blob;
}

async function uploadSegmentImage(index, file) {
  const li = $('segment-list').children[index];
  const drop = li?.querySelector('.image-drop');
  li?.querySelectorAll('.image-actions button, .image-actions input').forEach((b) => (b.disabled = true));
  drop?.classList.add('is-busy');
  drop?.replaceChildren(h('span', { class: 'spinner' }));
  try {
    const blob = await prepareImage(file);
    const res = await fetch('/api/admin/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showLogin('Your session ended. Sign in again — your unsaved changes are kept.');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Upload failed. Please try again.');
    const seg = state.draft.segments[index];
    if (!seg) return;
    seg.image = data.url;
    toast(`Image added to “${seg.label || `segment ${index + 1}`}”. Save to publish it.`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    renderSegments();
    onDraftChange();
    $('segment-list').children[index]?.querySelector('.file-btn input')?.focus();
  }
}

$('segment-list').addEventListener('change', (e) => {
  if (e.target.dataset.field !== 'imageFile') return;
  const li = e.target.closest('.segment');
  const file = e.target.files?.[0];
  if (li && file) uploadSegmentImage(Number(li.dataset.index), file);
});
$('segment-list').addEventListener('dragover', (e) => {
  const drop = e.target.closest('.image-drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.add('is-over');
});
$('segment-list').addEventListener('dragleave', (e) => e.target.closest('.image-drop')?.classList.remove('is-over'));
$('segment-list').addEventListener('drop', (e) => {
  const drop = e.target.closest('.image-drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('is-over');
  const file = e.dataTransfer.files?.[0];
  if (file) uploadSegmentImage(Number(drop.closest('.segment').dataset.index), file);
});

// ----- Logo and icon (Branding tab) -----
const BRAND_IMAGES = { logo: { fallback: DEFAULT_LOGO, maxSize: 800 }, icon: { fallback: DEFAULT_ICON, maxSize: 320 } };

function renderBrandImages() {
  for (const [kind, { fallback }] of Object.entries(BRAND_IMAGES)) {
    const custom = state.draft.branding[kind];
    $(`br-${kind}-img`).src = custom || fallback;
    $(`br-${kind}-btn`).textContent = custom ? 'Change' : 'Upload';
    $(`br-${kind}-reset`).hidden = !custom;
  }
}

async function uploadBrandImage(kind, file) {
  const label = $(`br-${kind}-btn`).closest('label');
  label.classList.add('is-busy');
  try {
    const blob = await prepareImage(file, BRAND_IMAGES[kind].maxSize);
    const res = await fetch('/api/admin/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showLogin('Your session ended. Sign in again — your unsaved changes are kept.');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Upload failed. Please try again.');
    state.draft.branding[kind] = data.url;
    toast(`New ${kind} added. Save to show it to players.`);
    onDraftChange();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    label.classList.remove('is-busy');
    renderBrandImages();
  }
}

for (const kind of Object.keys(BRAND_IMAGES)) {
  $(`br-${kind}-file`).addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again still counts
    if (file && state.draft) uploadBrandImage(kind, file);
  });
  $(`br-${kind}-reset`).addEventListener('click', () => {
    if (!state.draft) return;
    state.draft.branding[kind] = null;
    renderBrandImages();
    onDraftChange();
    $(`br-${kind}-file`).focus();
  });
}

// ----- "On the wheel" overview (beside the preview) -----
function renderEntries() {
  const segs = state.draft.segments;
  const o = odds(segs);
  const drawn = resolveColors(getStyle(state.draft.wheelStyle), segs);
  $('entries-count').textContent = segs.length;
  $('entries').replaceChildren(...segs.map((s, i) => {
    let right;
    if (!segAvailable(s)) {
      const soldOut = s.quantity !== null && s.quantity !== '' && Number(s.quantity) === 0;
      right = h('span', { class: 'e-note', text: s.hidden ? 'Hidden' : soldOut ? 'All claimed' : 'Not in play' });
    } else {
      right = h('span', { class: 'e-pct', text: fmtPct(o[i]) });
    }
    return h('li', {},
      h('button', {
        type: 'button', class: `entry${segAvailable(s) ? '' : ' is-off'}`, dataset: { edit: i },
        'aria-label': `Edit segment ${i + 1}: ${s.label || 'untitled'}`,
      },
        segThumb({ ...s, color: drawn[i] }),
        h('span', { class: 'e-name' },
          h('span', { class: 'e-label', text: s.label || 'Untitled' }),
          s.isPrize ? h('span', { class: 'e-tag', text: 'Gift' }) : null,
        ),
        right,
      ),
    );
  }));
}

$('entries').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit]');
  if (!btn) return;
  if (state.tab !== 'wheel') selectTab('wheel', { focus: false });
  const li = $('segment-list').children[Number(btn.dataset.edit)];
  if (!li) return;
  li.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  li.classList.remove('flash');
  void li.offsetWidth;
  li.classList.add('flash');
  li.querySelector('[data-field="label"]')?.focus({ preventScroll: true });
});

function refreshChances() {
  const o = odds(state.draft.segments);
  document.querySelectorAll('[data-chance]').forEach((el) => {
    el.textContent = `${fmtPct(o[Number(el.dataset.chance)])} chance`;
  });
}

/** Update the thumbnail and swatch states after the picture background changes. */
function refreshImageBg(li, seg) {
  li.querySelector('.image-row .thumb')?.replaceWith(segThumb(seg, 'image-drop', true));
  const current = seg.imageBg ?? '';
  li.querySelectorAll('.bg-chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.bg === current)));
  if (seg.imageBg) li.querySelector('[data-field="imageBg"]').value = seg.imageBg.toLowerCase();
}

$('segment-list').addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  const li = e.target.closest('.segment');
  if (!field || !li) return;
  const seg = state.draft.segments[Number(li.dataset.index)];
  const v = e.target.value;
  if (field === 'label') {
    seg.label = v;
    li.setAttribute('aria-label', `Segment ${Number(li.dataset.index) + 1}: ${v || 'untitled'}`);
  } else if (field === 'description') seg.description = v;
  else if (field === 'weight') seg.weight = v === '' ? '' : Number(v);
  else if (field === 'quantity') seg.quantity = v === '' ? null : Number(v);
  else if (field === 'isPrize') seg.isPrize = e.target.checked;
  else if (field === 'imageBg') {
    seg.imageBg = v.toUpperCase();
    refreshImageBg(li, seg);
  } else if (field === 'color') {
    seg.color = v.toUpperCase();
    li.style.setProperty('--seg-color', seg.color);
    li.querySelectorAll('.color-chip:not(.bg-chip)').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.color === seg.color)));
  }
  if (field === 'weight' || field === 'quantity') refreshChances();
  onDraftChange();
});

$('segment-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  const li = e.target.closest('.segment');
  if (!btn || !li) return;
  const i = Number(li.dataset.index);
  const segs = state.draft.segments;
  const action = btn.dataset.action;
  let focusIndex = i;
  let focusAction = action;

  if (action === 'image-bg') {
    segs[i].imageBg = btn.dataset.bg || null;
    refreshImageBg(li, segs[i]);
    onDraftChange();
    return;
  }
  if (action === 'remove-image') {
    segs[i].image = null;
    renderSegments();
    onDraftChange();
    $('segment-list').children[i]?.querySelector('.file-btn input')?.focus();
    return;
  }
  if (action === 'color') {
    segs[i].color = btn.dataset.color.toUpperCase();
    li.style.setProperty('--seg-color', segs[i].color);
    li.querySelectorAll('.color-chip:not(.bg-chip)').forEach((c) => c.setAttribute('aria-pressed', String(c === btn)));
    li.querySelector('.color-custom').value = segs[i].color.toLowerCase();
    onDraftChange();
    return;
  }
  if (action === 'up' && i > 0) {
    [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]];
    focusIndex = i - 1;
    if (focusIndex === 0) focusAction = 'down';
  } else if (action === 'down' && i < segs.length - 1) {
    [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]];
    focusIndex = i + 1;
    if (focusIndex === segs.length - 1) focusAction = 'up';
  } else if (action === 'hide') {
    segs[i].hidden = !segs[i].hidden;
    focusIndex = i;
    focusAction = 'hide';
  } else if (action === 'duplicate' && segs.length < MAX_SEGMENTS) {
    segs.splice(i + 1, 0, { ...clone(segs[i]), id: newId() });
    focusIndex = i + 1;
    focusAction = null;
  } else if (action === 'delete' && segs.length > MIN_SEGMENTS) {
    const label = segs[i].label || `Segment ${i + 1}`;
    const ok = await confirmDialog({
      title: `Delete “${label}”?`,
      body: 'This removes the segment from the wheel when you save. Past spins stay in the statistics.',
      confirmLabel: 'Delete segment',
    });
    if (!ok) return;
    segs.splice(i, 1);
    focusIndex = Math.min(i, segs.length - 1);
    focusAction = null;
  } else {
    return;
  }
  renderSegments();
  onDraftChange();
  const target = $('segment-list').children[focusIndex];
  (focusAction && target?.querySelector(`[data-action="${focusAction}"]:not(:disabled)`) || target?.querySelector('input'))?.focus();
});

$('add-segment').addEventListener('click', () => {
  const segs = state.draft.segments;
  if (segs.length >= MAX_SEGMENTS) return;
  const used = new Set(segs.slice(-2).map((s) => s.color));
  const color = PALETTE.find((p) => !used.has(p.hex))?.hex ?? PALETTE[0].hex;
  segs.push({ id: newId(), label: 'New gift', description: '', color, weight: 10, quantity: 10, isPrize: true });
  renderSegments();
  onDraftChange();
  const input = $('segment-list').lastElementChild.querySelector('[data-field="label"]');
  input.focus();
  input.select();
});

// ================= Availability & branding forms =================
function renderConfigForms() {
  const d = state.draft;
  $('av-enabled').checked = d.availability.enabled;
  $('av-details').checked = d.collectDetails !== false;
  $('av-hide').checked = d.hideUnavailable === true;
  $('av-start').value = toLocalInput(d.availability.startAt);
  $('av-end').value = toLocalInput(d.availability.endAt);
  $('av-limit').value = d.availability.spinsPerDevicePerDay;
  $('av-period').value = d.availability.limitPeriod === 'total' ? 'total' : 'day';
  $('av-closed').value = d.availability.closedMessage;
  $('br-title').value = d.branding.title;
  $('br-button').value = d.branding.spinButtonLabel;
  $('br-tagline').value = d.branding.tagline;
  $('br-instructions').value = d.branding.instructions.join('\n');
  $('br-disclaimer').value = d.branding.disclaimer;
  renderBrandImages();
  renderSegments();
  renderAvailabilityStatus();
  schedulePreview();
}

function renderAvailabilityStatus() {
  const s = draftStatus(state.draft);
  $('av-status').textContent = `With these settings players see: ${s.text}.`;
}

const formBindings = {
  'av-enabled': (el) => (state.draft.availability.enabled = el.checked),
  'av-details': (el) => (state.draft.collectDetails = el.checked),
  'av-hide': (el) => (state.draft.hideUnavailable = el.checked),
  'av-start': (el) => (state.draft.availability.startAt = fromLocalInput(el.value)),
  'av-end': (el) => (state.draft.availability.endAt = fromLocalInput(el.value)),
  'av-period': (el) => (state.draft.availability.limitPeriod = el.value),
  'av-limit': (el) => (state.draft.availability.spinsPerDevicePerDay = el.value === '' ? 0 : Number(el.value)),
  'av-closed': (el) => (state.draft.availability.closedMessage = el.value),
  'br-title': (el) => (state.draft.branding.title = el.value),
  'br-button': (el) => (state.draft.branding.spinButtonLabel = el.value),
  'br-tagline': (el) => (state.draft.branding.tagline = el.value),
  'br-instructions': (el) => (state.draft.branding.instructions = el.value.split('\n').map((l) => l.trim()).filter(Boolean)),
  'br-disclaimer': (el) => (state.draft.branding.disclaimer = el.value),
};
for (const [id, apply] of Object.entries(formBindings)) {
  const el = $(id);
  el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
    if (!state.draft) return;
    apply(el);
    renderAvailabilityStatus();
    onDraftChange();
  });
}
document.querySelectorAll('[data-clear]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.clear);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  });
});

// ================= Live preview =================
const pvWheel = new Spinner($('pv-wheel'), { label: 'Preview of the player wheel' });
let previewFrame = 0;
function schedulePreview() {
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(renderPreview);
}
/** The slices players see: all but hidden ones, and only available ones when "hide unavailable" is on (same rule as the server). */
function shownSegments(d) {
  const all = d.segments.map((s, i) => ({
    ...s,
    label: s.label || '—',
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#058F9A',
    available: segAvailable(s),
    soldOut: s.quantity !== null && s.quantity !== '' && Number(s.quantity) === 0,
    draftIndex: i,
  }));
  const visible = all.filter((s) => !s.hidden);
  if (!visible.length) return all; // can't be saved like this; keep the preview drawable meanwhile
  if (!d.hideUnavailable) return visible;
  const shown = visible.filter((s) => s.available);
  return shown.length ? shown : visible;
}

function renderPreview() {
  const d = state.draft;
  if (!d || $('preview').hidden) return;
  renderEntries();
  renderStyleNote();
  if (state.tab === 'style') renderStyleGallery();
  if (pvWheel.spinning) return;
  setBrand(d.branding); // logo + icon in the preview and style cards
  if (pvWheel.style.id !== getStyle(d.wheelStyle).id) pvWheel.setStyle(d.wheelStyle);
  $('pv-title').textContent = d.branding.title || 'Untitled';
  $('pv-tagline').textContent = d.branding.tagline;
  $('pv-button').textContent = d.branding.spinButtonLabel || 'Spin';
  pvWheel.setSegments(shownSegments(d));
  const status = draftStatus(d);
  pvWheel.setClosed(!status.open);
  $('pv-closed').hidden = status.open;
  $('pv-closed').textContent = status.text;
}

// ----- Style gallery -----
const styleCards = new Map(); // id -> { button, wheel }

function previewSegments(d) {
  return d.segments.map((s) => ({
    ...s,
    label: s.label || '—',
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#058F9A',
    available: segAvailable(s),
    soldOut: s.quantity !== null && s.quantity !== '' && Number(s.quantity) === 0,
  }));
}

function renderStyleGallery() {
  const gallery = $('style-gallery');
  if (!styleCards.size) {
    for (const st of WHEEL_STYLES) {
      const stage = h('div', { class: 'style-wheel' });
      const button = h('button', { type: 'button', class: 'style-card', dataset: { style: st.id }, 'aria-pressed': 'false' },
        stage,
        h('span', { class: 'style-name' }, st.name, h('span', { class: 'style-check', 'aria-hidden': 'true', text: '✓' })),
        h('span', { class: 'style-note', text: st.note }),
      );
      gallery.append(button);
      const wheel = new Spinner(stage, { style: st.id, label: `${st.name} style` });
      wheel.root.setAttribute('aria-hidden', 'true');
      styleCards.set(st.id, { button, wheel });
    }
  }
  const segs = previewSegments(state.draft);
  const current = getStyle(state.draft.wheelStyle).id;
  for (const [id, { button, wheel }] of styleCards) {
    wheel.setSegments(segs);
    button.setAttribute('aria-pressed', String(id === current));
  }
}

function chooseStyle(id) {
  if (!state.draft) return;
  state.draft.wheelStyle = id;
  for (const [sid, { button }] of styleCards) button.setAttribute('aria-pressed', String(sid === id));
  onDraftChange();
}

$('style-gallery').addEventListener('click', (e) => {
  const card = e.target.closest('[data-style]');
  if (card) chooseStyle(card.dataset.style);
});

$('random-style').addEventListener('click', () => {
  const current = getStyle(state.draft?.wheelStyle).id;
  const others = WHEEL_STYLES.filter((s) => s.id !== current);
  const pick = others[Math.floor(Math.random() * others.length)];
  chooseStyle(pick.id);
  styleCards.get(pick.id)?.button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(`Trying “${pick.name}”. Save to show it to players.`);
});

/** Tell editors when segment colours are overridden by the chosen style. */
function renderStyleNote() {
  const st = getStyle(state.draft.wheelStyle);
  const note = $('style-color-note');
  note.hidden = !st.palette;
  note.textContent = st.palette
    ? `The “${st.name}” style uses its own colours, so the colours below are not shown on the wheel. Choose “Classic”, “Carnival lights”, “Lucky slots”, “Capsule machine” or “Lucky drop” on the Style tab to use them.`
    : '';
}

$('test-spin').addEventListener('click', async () => {
  const segs = state.draft.segments;
  const o = odds(segs);
  if (!o.some((p) => p > 0)) {
    $('test-result').textContent = 'No segment can be landed on — give at least one a weight and stock.';
    return;
  }
  let r = Math.random();
  let index = o.findIndex((p) => (r -= p) < 0);
  if (index < 0) index = o.findLastIndex((p) => p > 0);
  const btn = $('test-spin');
  btn.disabled = true;
  $('test-result').textContent = 'Spinning…';
  renderPreview();
  await pvWheel.spinTo(pvWheel.segments.findIndex((s) => s.draftIndex === index), { duration: 3200, turns: 4, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  btn.disabled = false;
  $('test-result').textContent = `Test result: “${segs[index].label}”. Not recorded.`;
});

// ================= Dashboard =================
let refreshTimer;
function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (state.tab === 'dashboard' && document.visibilityState === 'visible') loadStats({ quiet: true });
  }, 20_000);
}
function stopAutoRefresh() {
  clearInterval(refreshTimer);
}

let statsLoading = false;
async function loadStats({ quiet = false } = {}) {
  if (statsLoading || $('app-view').hidden) return;
  statsLoading = true;
  const btn = $('refresh-stats');
  if (!quiet) btn.disabled = true;
  try {
    state.stats = await api('/api/admin/stats');
    renderDashboard();
    if (state.tab === 'wheel' && !document.querySelector('#segment-list :focus')) renderSegments();
  } catch (err) {
    if (!quiet && err.status !== 401) toast(err.message, 'error');
  } finally {
    statsLoading = false;
    btn.disabled = false;
  }
}

$('refresh-stats').addEventListener('click', async () => {
  await loadStats();
  toast('Dashboard updated.');
});

function renderDashboard() {
  const s = state.stats;
  const t = s.totals;
  const prizeSegs = s.segments.filter((x) => x.isPrize);
  const stockKnown = prizeSegs.filter((x) => x.remaining !== null);
  const stockLeft = stockKnown.reduce((a, x) => a + x.remaining, 0);
  const tile = (label, value, sub) =>
    h('div', { class: 'tile' }, h('p', { class: 'tile-label', text: label }), h('p', { class: 'tile-value', text: value }), sub ? h('p', { class: 'tile-sub', text: sub }) : null);
  $('tiles').replaceChildren(
    tile('Spins today', fmtInt(t.spinsToday), t.playersToday
      ? `${fmtInt(t.playersToday)} player${t.playersToday === 1 ? '' : 's'}`
      : `${fmtInt(t.devicesToday)} device${t.devicesToday === 1 ? '' : 's'}`),
    tile('Total spins', fmtInt(t.spins), 'All time'),
    tile('Gifts won', fmtInt(t.prizesAwarded), `${fmtInt(t.prizesToday)} today`),
    tile('Handed out', fmtInt(t.redeemed), `${fmtInt(Math.max(0, t.prizesAwarded - t.redeemed))} still to collect`),
    tile('Gifts in stock', stockKnown.length ? fmtInt(stockLeft) : '—', `${prizeSegs.length} gift type${prizeSegs.length === 1 ? '' : 's'}`),
  );

  const pill = $('status-pill');
  const st = s.status;
  const reasons = { disabled: 'Closed — switched off', 'not-started': 'Closed — not started', ended: 'Closed — ended', 'no-outcomes': 'Closed — nothing left to win' };
  pill.textContent = st.open ? 'Game is open' : reasons[st.reason] ?? 'Closed';
  pill.className = `pill ${st.open ? 'pill-success' : 'pill-warning'}`;
  $('stats-updated').textContent = `Updated ${new Date(s.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.`;

  renderDailyChart(s.days);
  renderOutcomes(s);
  runQuery(); // Recent spins: latest, or the current search / day filter
}

function renderOutcomes(s) {
  const maxHits = Math.max(1, ...s.segments.map((x) => x.hits));
  const stockCell = (x) => {
    if (x.remaining === null) return h('span', { class: 'hint', text: 'Unlimited' });
    if (x.remaining === 0) return h('span', { class: 'pill pill-danger', text: 'All claimed' });
    if (x.remaining <= 5) return h('span', { class: 'pill pill-warning', text: `Low · ${x.remaining}` });
    return fmtInt(x.remaining);
  };
  const rows = s.segments.map((x) => {
    const meter = h('span', { class: 'meter', 'aria-hidden': 'true' }, h('span'));
    meter.firstChild.style.width = `${(x.hits / maxHits) * 100}%`;
    const sw = h('span', { class: 'swatch', 'aria-hidden': 'true' });
    sw.style.background = x.color;
    return h('tr', {},
      h('td', {}, h('span', { class: 'cell-outcome' }, sw, x.label)),
      h('td', { text: x.isPrize ? 'Gift' : 'Message' }),
      h('td', { class: 'num', text: fmtPct(x.odds) }),
      h('td', { class: 'num', text: fmtInt(x.hitsToday) }),
      h('td', { class: 'num' }, fmtInt(x.hits), meter),
      h('td', { class: 'num' }, stockCell(x)),
    );
  });
  $('outcomes-table').replaceChildren(
    h('caption', { class: 'visually-hidden', text: 'Outcomes, chances and stock' }),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: 'Outcome' }), h('th', { scope: 'col', text: 'Type' }),
      h('th', { scope: 'col', class: 'num', text: 'Chance' }), h('th', { scope: 'col', class: 'num', text: 'Today' }),
      h('th', { scope: 'col', class: 'num', text: 'All time' }), h('th', { scope: 'col', class: 'num', text: 'Stock left' }),
    )),
    h('tbody', {}, rows),
  );
  $('removed-note').hidden = !s.removedSegmentHits;
  $('removed-note').textContent = `${fmtInt(s.removedSegmentHits)} spin(s) landed on segments that have since been removed.`;
}

function renderRecent(spins) {
  const rows = spins.length
    ? spins.map((sp) => {
        let action;
        if (!sp.isPrize) action = h('span', { class: 'hint', text: '—' });
        else {
          action = h('button', {
            type: 'button',
            class: `btn btn-sm ${sp.redeemed ? 'btn-ghost' : 'btn-secondary'}`,
            dataset: { redeem: sp.id, value: String(!sp.redeemed) },
            'aria-label': sp.redeemed ? `Undo handed out for ${sp.code}` : `Mark ${sp.code} as handed out`,
            text: sp.redeemed ? '✓ Handed out · Undo' : 'Mark handed out',
          });
        }
        const who = sp.name
          ? h('span', { class: 'who' }, h('strong', { text: sp.name }), h('span', { class: 'who-phone', text: sp.phone ?? '' }))
          : h('span', { class: 'hint', text: '—' });
        return h('tr', {},
          h('td', { text: fmtTime(sp.at) }),
          h('td', {}, who),
          h('td', { text: sp.label }),
          h('td', {}, sp.code ? h('span', { class: 'code', text: sp.code }) : h('span', { class: 'hint', text: '—' })),
          h('td', {}, action),
        );
      })
    : [h('tr', { class: 'empty-row' }, h('td', { colspan: '5', text: emptyText() }))];
  $('recent-table').replaceChildren(
    h('caption', { class: 'visually-hidden', text: filtering() ? 'Filtered spins' : 'Most recent spins' }),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: 'Time' }), h('th', { scope: 'col', text: 'Player' }), h('th', { scope: 'col', text: 'Outcome' }),
      h('th', { scope: 'col', text: 'Claim code' }), h('th', { scope: 'col', text: 'Gift status' }),
    )),
    h('tbody', {}, rows),
  );
}

$('recent-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-redeem]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const { spin } = await api(`/api/admin/spins/${btn.dataset.redeem}/redeem`, { method: 'POST', body: { redeemed: btn.dataset.value === 'true' } });
    toast(spin.redeemed ? `${spin.code} marked as handed out.` : `${spin.code} marked as not handed out.`);
    await loadStats({ quiet: true }); // also refreshes a filtered list
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
    btn.disabled = false;
  }
});

// ----- Search + day filter for Recent spins -----
const filtering = () => Boolean(state.searchQ || state.day);
const fmtDay = (key) => parseDay(key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`;
/** Today on the server's clock (the last day of the stats chart), falling back to this browser. */
function todayKey() {
  const last = state.stats?.days?.at(-1)?.day;
  if (last) return last;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDay(key, by) {
  const d = parseDay(key);
  d.setDate(d.getDate() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function emptyText() {
  if (state.day && state.searchQ) return `No spins on ${fmtDay(state.day)} match “${state.searchQ}”.`;
  if (state.day) return `No spins on ${fmtDay(state.day)}.`;
  if (state.searchQ) return `No spins match “${state.searchQ}”.`;
  return 'No spins yet. They will appear here as players spin.';
}

let lastResult = { total: 0, prizes: 0 };
let queryId = 0;
async function runQuery() {
  syncDayControls();
  if (!filtering()) {
    $('spin-summary').textContent = '';
    $('delete-day').hidden = true;
    return renderRecent(state.stats?.recent ?? []);
  }
  const id = ++queryId;
  const params = new URLSearchParams({ limit: state.day ? '200' : '50' });
  if (state.searchQ) params.set('q', state.searchQ);
  if (state.day) params.set('day', state.day);
  try {
    const res = await api(`/api/admin/spins?${params}`);
    if (id !== queryId) return; // a newer filter won
    lastResult = res;
    renderRecent(res.spins);
    const where = state.day ? ` on ${fmtDay(state.day)}` : '';
    const more = res.total > res.spins.length ? ` · showing the latest ${fmtInt(res.spins.length)}` : '';
    $('spin-summary').textContent = `${plural(res.total, 'spin')}${where} · ${plural(res.prizes, 'gift')}${more}`;
    $('delete-day').hidden = !state.day || state.searchQ !== '' || res.total === 0;
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  }
}

function syncDayControls() {
  const today = todayKey();
  const input = $('spin-day');
  input.max = today;
  input.value = state.day;
  const label = !state.day ? 'All days'
    : state.day === today ? 'Today'
    : state.day === shiftDay(today, -1) ? 'Yesterday'
    : parseDay(state.day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(state.day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
  $('day-label').textContent = label;
  $('day-open').setAttribute('aria-label', `Choose a day. Showing: ${label}`);
  $('day-next').disabled = !state.day || state.day >= today;
  $('day-today').disabled = state.day === today;
  $('day-all').hidden = !state.day;
}
function setDay(key) {
  state.day = key;
  runQuery();
}

$('spin-search').addEventListener('submit', (e) => {
  e.preventDefault();
  state.searchQ = $('spin-q').value.trim();
  runQuery();
});
$('spin-q').addEventListener('input', () => {
  if (!$('spin-q').value.trim() && state.searchQ) {
    state.searchQ = '';
    runQuery();
  }
});
$('spin-day').addEventListener('change', (e) => setDay(e.target.value));
$('day-open').addEventListener('click', () => {
  const input = $('spin-day');
  try {
    input.showPicker();
  } catch {
    input.focus(); // older browsers: the date field takes keyboard input
  }
});
$('day-prev').addEventListener('click', () => setDay(shiftDay(state.day || todayKey(), state.day ? -1 : 0)));
$('day-next').addEventListener('click', () => state.day && setDay(shiftDay(state.day, 1)));
$('day-today').addEventListener('click', () => setDay(todayKey()));
$('day-all').addEventListener('click', () => setDay(''));

$('delete-day').addEventListener('click', async () => {
  const day = state.day;
  if (!day) return;
  const { total, prizes } = lastResult;
  const ok = await confirmDialog({
    title: `Delete spins from ${fmtDay(day)}?`,
    body: `This permanently deletes ${plural(total, 'spin')} (${plural(prizes, 'gift')}) from that day, with their claim codes, names and phone numbers. Players from that day will be able to spin again. Gift stock does not change. Export to Excel first if you need a copy. This cannot be undone.`,
    confirmLabel: 'Delete spins',
    typeToConfirm: 'DELETE',
  });
  if (!ok) return;
  try {
    const { deleted } = await api('/api/admin/spins/delete-day', { method: 'POST', body: { day, confirm: 'DELETE' } });
    toast(`Deleted ${plural(deleted, 'spin')} from ${fmtDay(day)}.`);
    await loadStats({ quiet: true });
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  }
});

$('reset-stats').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Reset all statistics?',
    body: 'This permanently deletes every recorded spin, claim code, name and phone number. Export to Excel first if you need a copy. Wheel settings and stock stay as they are. This cannot be undone.',
    confirmLabel: 'Reset statistics',
    typeToConfirm: 'RESET',
  });
  if (!ok) return;
  try {
    await api('/api/admin/stats/reset', { method: 'POST', body: { confirm: 'RESET' } });
    toast('Statistics were reset.');
    state.searchQ = '';
    state.day = '';
    $('spin-q').value = '';
    loadStats();
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  }
});

// ----- Daily bar chart (single series, hover tooltip, table fallback) -----
function niceMax(v) {
  // Axis shows 0, max/2 and max, so max must be twice a "nice" step.
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v / 2));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow * 2 >= v) return m * pow * 2;
  return 20 * pow;
}

function svg(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}

function renderDailyChart(days) {
  const box = $('daily-chart');
  const W = Math.max(box.clientWidth || 600, 280);
  const H = 220;
  const m = { top: 12, right: 4, bottom: 26, left: 34 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(...days.map((d) => d.spins)));
  const y = (v) => m.top + ih - (v / max) * ih;
  const band = iw / days.length;
  const barW = Math.max(6, Math.min(32, band - 2) * 0.72);
  const total = days.reduce((a, d) => a + d.spins, 0);
  const peak = days.reduce((a, d) => (d.spins > a.spins ? d : a), days[0]);
  const dayLabel = (d, i) => (i === days.length - 1 ? 'Today' : parseDay(d.day).toLocaleDateString([], { month: 'short', day: 'numeric' }));

  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `Bar chart of spins per day over the last 14 days. ${total} spins in total${peak.spins ? `; busiest day ${dayLabel(peak, days.indexOf(peak))} with ${peak.spins}` : ''}. A table view is available below.`,
  });
  const grid = svg('g', { class: 'grid' }, root);
  for (const v of [0, max / 2, max]) {
    svg('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }, grid);
    const t = svg('text', { x: m.left - 8, y: y(v), 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'axis-label' }, root);
    t.textContent = fmtInt(v);
  }
  const showEvery = band < 40 ? 2 : 1;
  days.forEach((d, i) => {
    const cx = m.left + band * i + band / 2;
    const g = svg('g', { class: 'col' }, root);
    g.dataset.i = i;
    svg('rect', { class: 'hit', x: m.left + band * i, y: m.top, width: band, height: ih }, g);
    const bh = (d.spins / max) * ih;
    if (bh > 0) {
      const r = Math.min(4, bh, barW / 2);
      const x0 = cx - barW / 2;
      const yb = m.top + ih;
      const yt = yb - bh;
      svg('path', {
        class: `bar${i === days.length - 1 ? ' is-today' : ''}`,
        d: `M${x0},${yb} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x0 + barW - r} Q${x0 + barW},${yt} ${x0 + barW},${yt + r} V${yb} Z`,
      }, g);
    }
    if ((days.length - 1 - i) % showEvery === 0) {
      const t = svg('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, root);
      t.textContent = dayLabel(d, i);
    }
  });
  const tip = $('chart-tip');
  const show = (e) => {
    const col = e.target.closest('.col');
    if (!col) return;
    root.querySelectorAll('.col.is-active').forEach((c) => c.classList.remove('is-active'));
    col.classList.add('is-active');
    const d = days[Number(col.dataset.i)];
    const rect = col.querySelector('.hit').getBoundingClientRect();
    tip.replaceChildren(
      h('strong', { text: parseDay(d.day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) }),
      `${fmtInt(d.spins)} spin${d.spins === 1 ? '' : 's'} · ${fmtInt(d.prizes)} gift${d.prizes === 1 ? '' : 's'}`,
    );
    tip.hidden = false;
    tip.style.left = `${rect.left + rect.width / 2}px`;
    tip.style.top = `${Math.max(rect.top + (y(d.spins) - m.top) * (rect.height / ih), 40)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    root.querySelectorAll('.col.is-active').forEach((c) => c.classList.remove('is-active'));
  };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerdown', show);
  root.addEventListener('pointerleave', hide);
  root.addEventListener('click', (e) => {
    const col = e.target.closest('.col');
    if (!col) return;
    setDay(days[Number(col.dataset.i)].day);
    $('recent-table').closest('.block').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  root.querySelectorAll('.col').forEach((c) => c.classList.toggle('is-selected', days[Number(c.dataset.i)].day === state.day));
  box.replaceChildren(root);

  $('daily-table').replaceChildren(
    h('caption', { class: 'visually-hidden', text: 'Spins and gifts per day, last 14 days' }),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Day' }), h('th', { scope: 'col', class: 'num', text: 'Spins' }), h('th', { scope: 'col', class: 'num', text: 'Gifts won' }))),
    h('tbody', {}, days.slice().reverse().map((d) =>
      h('tr', {}, h('td', { text: parseDay(d.day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) }), h('td', { class: 'num', text: fmtInt(d.spins) }), h('td', { class: 'num', text: fmtInt(d.prizes) })),
    )),
  );
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.stats && renderDailyChart(state.stats.days), 150);
});
window.addEventListener('scroll', () => ($('chart-tip').hidden = true), { passive: true });

// ================= Security =================
$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('pw-error');
  const cur = $('pw-current');
  const next = $('pw-new');
  const conf = $('pw-confirm');
  [cur, next, conf].forEach((i) => i.removeAttribute('aria-invalid'));
  err.textContent = '';
  const fail = (msg, input) => {
    err.textContent = msg;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };
  if (!cur.value) return fail('Enter your current password.', cur);
  if (next.value.length < 10) return fail('Use at least 10 characters for the new password.', next);
  if (next.value !== conf.value) return fail('The new passwords do not match.', conf);
  if (next.value === cur.value) return fail('Choose a password that is different from the current one.', next);

  const btn = $('pw-submit');
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Updating…');
  try {
    await api('/api/admin/password', { method: 'POST', body: { currentPassword: cur.value, newPassword: next.value } });
    e.target.reset();
    toast('Password updated. Other devices were signed out.');
  } catch (ex) {
    if (ex.status !== 401) fail(ex.message, ex.data?.field === 'currentPassword' ? cur : next);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update password';
  }
});

// ================= Confirm dialog =================
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = true, typeToConfirm = null }) {
  const dlg = $('confirm-dialog');
  const ok = $('confirm-ok');
  const wrap = $('confirm-type-wrap');
  const input = $('confirm-type');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  ok.textContent = confirmLabel;
  dlg.classList.toggle('is-safe', !danger);
  wrap.hidden = !typeToConfirm;
  input.value = '';
  ok.disabled = !!typeToConfirm;
  if (typeToConfirm) {
    $('confirm-type-label').textContent = `Type ${typeToConfirm} to confirm`;
    input.oninput = () => (ok.disabled = input.value.trim() !== typeToConfirm);
  }
  dlg.returnValue = '';
  dlg.showModal();
  (typeToConfirm ? input : dlg.querySelector('button[value="cancel"]')).focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' && (!typeToConfirm || input.value.trim() === typeToConfirm));
    }, { once: true });
  });
}

// ================= Start =================
(async function init() {
  try {
    const { authenticated } = await api('/api/admin/session');
    if (authenticated) await enterApp();
    else showLogin();
  } catch {
    showLogin('Could not reach the server. Check your connection and try again.');
  }
})();

// ================= Theme =================
// The admin keeps its own light/dark choice, so it never changes the game on a shared device.
const THEME_KEY = 'pk-spin-admin-theme';
const themeBtn = $('theme-toggle');
function renderTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeBtn.setAttribute('aria-pressed', String(dark));
  themeBtn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}
themeBtn.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* ignore */ }
  renderTheme();
});
renderTheme();
