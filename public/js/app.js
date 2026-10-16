// PharmKulen Spin — player game.
import { labelColorFor, monogram, pictureBox } from './wheel.js';
import { Spinner } from './spinner.js';
import { setBrand, brandMark } from './brand.js';
import { getStyle } from './styles.js';
import { Sound, confetti } from './fx.js';

const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'pk-spin-history';
const SOUND_KEY = 'pk-spin-sound';
const THEME_KEY = 'pk-spin-theme';
const OLD_PLAYER_KEY = 'pk-spin-player'; // used by an earlier "Remember me" option
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  game: null,
  spinning: false,
  history: loadHistory(),
  player: null, // { name, phone } for the person currently playing
  spinAgainPending: false,
};

const sound = new Sound(localStorage.getItem(SOUND_KEY) !== 'off');
const wheel = new Spinner($('wheel'), { onTick: () => sound.tick(), label: 'PharmKulen prize wheel' });

// ---------- helpers ----------
function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(list) ? list.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function setPlayer(player) {
  state.player = player;
  if (!player) {
    // Never show one customer's details to the next one on a shared device.
    $('player-name-input').value = '';
    $('player-phone-input').value = '';
  }
  // A different person may have a different daily allowance.
  if (state.game?.collectDetails) state.game.spinsLeft = null;
  renderPlayer();
  updateControls();
}

function renderPlayer() {
  const show = !!(state.game?.collectDetails && state.player);
  $('player-chip').hidden = !show;
  if (show) {
    $('player-name').textContent = state.player.name;
    $('player-phone').textContent = state.player.phone;
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 20)));
  } catch { /* storage full or disabled — history just won't persist */ }
}

function formatTime(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDate(iso) {
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function pct(p) {
  if (p <= 0) return '0%';
  if (p < 0.01) return '<1%';
  return `${Math.round(p * 100)}%`;
}

function announce(text) {
  const live = $('live');
  live.textContent = '';
  setTimeout(() => (live.textContent = text), 50);
}

function toast(message, kind = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  t.textContent = message;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- rendering ----------
/** Faint brand marks across the game background, on the same 360px grid as the pattern (see .stage-logos). */
function buildStageLogos() {
  const box = document.createElement('div');
  box.className = 'stage-logos';
  box.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 36; i++) {
    const cell = document.createElement('div');
    for (const k of ['a', 'b']) {
      const img = document.createElement('img');
      img.className = `stage-logo stage-logo-${k}`;
      img.alt = '';
      img.decoding = 'async';
      img.dataset.brand = 'mark';
      img.src = brandMark();
      cell.append(img);
    }
    box.append(cell);
  }
  $('play').prepend(box);
}
buildStageLogos();

function renderBranding(b) {
  setBrand(b);
  $('game-title').textContent = b.title;
  document.title = `${b.title} · PharmKulen`;
  $('tagline').textContent = b.tagline;
  $('tagline').hidden = !b.tagline;
  $('spin-label').textContent = b.spinButtonLabel;
  $('disclaimer').textContent = b.disclaimer;
  $('disclaimer').hidden = !b.disclaimer;
  const list = $('instructions');
  list.replaceChildren(...b.instructions.map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  }));
}

function updateControls() {
  const game = state.game;
  const btn = $('spin-btn');
  const meta = $('spin-meta');
  meta.classList.remove('is-error');
  if (!game) return;

  const open = game.status.open;
  const out = game.spinsLeft === 0;
  btn.disabled = state.spinning || !open || out;
  btn.classList.toggle('is-busy', state.spinning);
  $('spin-label').textContent = state.spinning ? 'Spinning…' : game.branding.spinButtonLabel;
  // With player details on, a finished player hands over to the next person.
  const nextPlayer = game.collectDetails && out;
  $('spin-again').hidden = !open || (out && !game.collectDetails);
  $('spin-again').textContent = nextPlayer ? 'Next player' : 'Spin again';
  $('spin-again').dataset.mode = nextPlayer ? 'next' : 'again';

  wheel.setClosed(!open);
  $('play').classList.toggle('can-spin', !btn.disabled);
  $('closed-overlay').hidden = open;
  if (!open) {
    const s = game.status;
    $('closed-title').textContent =
      s.reason === 'not-started' ? 'Opening soon' : s.reason === 'ended' ? 'This round has ended' : 'Taking a break';
    $('closed-message').textContent =
      s.reason === 'not-started' && s.startAt ? `${s.message} Opens ${formatDate(s.startAt)}.` : s.message;
    meta.textContent = 'The wheel is closed right now.';
    return;
  }
  if (state.spinning) {
    meta.textContent = 'Good luck!';
  } else if (out) {
    meta.textContent = game.collectDetails
      ? 'Thanks for playing! Next player: press Spin and enter your own details.'
      : game.limitPeriod === 'total'
        ? "You've used all your spins. Thanks for playing!"
        : "You've used today's spins. Come back tomorrow!";
  } else if (game.spinsLeft !== null && game.spinsLeft !== undefined) {
    meta.textContent = `${game.spinsLeft} spin${game.spinsLeft === 1 ? '' : 's'} left today`;
  } else if (game.collectDetails && !state.player) {
    const n = game.spinsPerDay;
    meta.textContent = n
      ? `Press Spin and enter your name and phone · ${n} spin${n === 1 ? '' : 's'} per phone number${game.limitPeriod === 'day' ? ' a day' : ''}`
      : 'Press Spin and enter your name and phone to play';
  } else {
    meta.textContent = 'Tap the wheel or press Spin';
  }
}

/** Small round picture for a result, falling back to a coloured badge. */
function resultIcon(entry, className) {
  const box = document.createElement('div');
  box.className = className;
  box.setAttribute('aria-hidden', 'true');
  box.style.background = entry.color;
  box.style.color = labelColorFor(entry.color).color;
  if (entry.image) {
    const img = document.createElement('img');
    img.src = entry.image;
    img.alt = '';
    img.addEventListener('error', () => { img.remove(); box.textContent = monogram(entry.label); });
    box.classList.add('has-image');
    box.append(img);
    pictureBox(box, entry);
  } else {
    box.textContent = monogram(entry.label);
  }
  return box;
}

function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth; // restart the animation
  el.classList.add('bump');
}

function renderLatest(entry) {
  const box = $('latest');
  if (!entry) return;
  const card = document.createElement('div');
  card.className = `latest-card ${entry.isPrize ? 'is-prize' : 'is-neutral'}`;
  card.style.setProperty('--c', entry.color);
  const dot = resultIcon(entry, 'latest-dot');
  const body = document.createElement('div');
  body.className = 'latest-body';
  const kicker = document.createElement('p');
  kicker.className = 'latest-kicker';
  kicker.textContent = entry.isPrize ? 'Latest win' : 'Latest result';
  body.append(kicker);
  const label = document.createElement('p');
  label.className = 'latest-label';
  label.textContent = entry.label;
  const desc = document.createElement('p');
  desc.className = 'latest-desc';
  desc.textContent = entry.description || (entry.isPrize ? 'Show your claim code to a team member.' : 'Thanks for playing!');
  body.append(label, desc);
  card.append(dot, body);
  if (entry.code) {
    const ticket = document.createElement('p');
    ticket.className = 'latest-code';
    const cap = document.createElement('span');
    cap.className = 'latest-code-cap';
    cap.textContent = 'Claim code';
    const code = document.createElement('strong');
    code.textContent = entry.code;
    ticket.append(cap, code);
    card.append(ticket);
  }
  box.replaceChildren(card);
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren(...state.history.map((h) => {
    const li = document.createElement('li');
    li.className = h.isPrize ? 'is-prize' : 'is-neutral';
    li.style.setProperty('--c', h.color);
    const dot = resultIcon(h, 'dot');
    const text = document.createElement('span');
    text.className = 'h-text';
    const label = document.createElement('span');
    label.className = 'h-label';
    label.textContent = h.label;
    text.append(label);
    if (h.code) {
      const code = document.createElement('span');
      code.className = 'h-code';
      code.textContent = h.code;
      text.append(code);
    }
    const time = document.createElement('time');
    time.dateTime = h.at;
    time.textContent = formatTime(h.at);
    li.append(dot, text, time);
    return li;
  }));
  $('results-count').textContent = state.history.length;
  $('history-empty').hidden = state.history.length > 0;
  $('clear-history').hidden = state.history.length === 0;
}

/** Switch the wheel's look when staff pick another style in Admin. */
function applyStyle(id) {
  const style = getStyle(id);
  if (wheel.style.id !== style.id) wheel.setStyle(style);
  // Height ÷ width of each machine (measured), used by the CSS to fit it on screen.
  const ratio = { slot: 1.25, capsule: 1.14, plinko: 1.34, claw: 1.36 }[style.kind] ?? 1;
  document.querySelector('.wheel-wrap').style.setProperty('--ar', ratio);
  if (style.glow) $('play').style.setProperty('--wheel-glow', style.glow);
  else $('play').style.removeProperty('--wheel-glow');
}

/** Same slices in the same order, each equally available? (Hidden sold-out gifts change the list.) */
function sameSegments(a, b) {
  return a.length === b.length && a.every((s, i) => s.id === b[i].id && s.available === b[i].available);
}

function applyGame(game) {
  const prevVersion = state.game?.version;
  state.game = game;
  renderBranding(game.branding);
  if (!game.collectDetails) state.player = null;
  renderPlayer();
  applyStyle(game.wheelStyle);
  if (prevVersion !== game.version || !wheel.segments.length) {
    wheel.setSegments(game.segments);
  } else {
    // Availability (stock) can change without a config version bump.
    if (!sameSegments(wheel.segments, game.segments)) wheel.setSegments(game.segments);
  }
  updateControls();
}

async function loadGame() {
  try {
    applyGame(await api('/api/game'));
  } catch (err) {
    $('spin-meta').textContent = 'We could not load the wheel. Check your connection and refresh.';
    $('spin-meta').classList.add('is-error');
  }
}

// ---------- spinning ----------
async function spin() {
  if (state.spinning || !state.game?.status.open || state.game.spinsLeft === 0) return;
  sound.ensure(); // unlock audio within the user gesture
  if (state.game.collectDetails && !state.player) {
    openDetails();
    return;
  }
  state.spinning = true;
  updateControls();

  const body = state.game.collectDetails
    ? { name: state.player.name, phone: state.player.phone }
    : {};
  let result;
  try {
    result = await api('/api/spin', { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    state.spinning = false;
    if (err.data?.status) state.game.status = err.data.status;
    if (err.data?.phoneUsed) {
      // That phone number can't play again: ask for a different person's details.
      setPlayer(null);
      openDetails({ phone: err.message });
      announce(err.message);
      return;
    }
    if (err.data?.spinsLeft === 0) state.game.spinsLeft = 0;
    if (err.data?.needDetails) {
      state.game.collectDetails = true;
      updateControls();
      openDetails(err.data.fields);
      return;
    }
    updateControls();
    $('spin-meta').textContent = err.message;
    $('spin-meta').classList.add('is-error');
    announce(err.message);
    return;
  }

  // If staff changed the wheel since this page loaded, redraw it first.
  if (result.version !== state.game.version) {
    state.game.version = result.version;
    state.game.wheelStyle = result.wheelStyle;
    applyStyle(result.wheelStyle);
    wheel.setSegments(result.wheel);
  } else if (!sameSegments(wheel.segments, result.wheel)) {
    // Stock changed since the page loaded (e.g. a gift ran out and is now hidden): spin on the current wheel.
    wheel.setSegments(result.wheel);
  }

  await wheel.spinTo(result.index, { reducedMotion: reducedMotion.matches });

  state.spinning = false;
  state.game.spinsLeft = result.spinsLeft;
  state.game.segments = result.segments;

  const entry = {
    at: result.at,
    label: result.segment.label,
    description: result.segment.description,
    color: wheel.colors[result.index] ?? result.segment.color, // the colour as drawn in the current style
    isPrize: result.segment.isPrize,
    image: result.segment.image,
    imageBg: result.segment.imageBg ?? null,
    code: result.code,
  };
  state.history.unshift(entry);
  saveHistory();
  renderHistory();
  renderLatest(entry);
  bump($('results-count'));
  updateControls();
  celebrate(entry);
}

/** Firework bursts around the result card (built once). */
function buildFireworks() {
  const box = $('rd-fireworks');
  if (box.childElementCount) return;
  const spots = [[6, 14, '#F7D27A'], [86, 8, '#44E4BC'], [92, 46, '#62DBFF'], [2, 52, '#FF9FB2'], [80, 78, '#F7D27A'], [12, 84, '#19B2FF']];
  spots.forEach(([x, y, color], n) => {
    const fw = document.createElement('span');
    fw.className = 'rd-fw';
    fw.style.left = `${x}%`;
    fw.style.top = `${y}%`;
    fw.style.setProperty('--fc', color);
    fw.style.animationDelay = `${n * 0.28}s`;
    for (let i = 0; i < 12; i++) {
      const ray = document.createElement('i');
      ray.style.setProperty('--a', `${i * 30}deg`);
      fw.append(ray);
    }
    box.append(fw);
  });
}

function celebrate(entry) {
  const dlg = $('result-dialog');
  buildFireworks();
  dlg.classList.toggle('is-gift', entry.isPrize);
  dlg.classList.toggle('is-neutral', !entry.isPrize);
  $('result-badge').replaceWith(Object.assign(resultIcon(entry, 'result-badge'), { id: 'result-badge' }));
  $('result-heading').textContent = entry.isPrize ? 'Congratulations!' : 'Thank you!';
  $('result-kicker').textContent = entry.isPrize ? 'You won' : 'You landed on';
  $('result-title').textContent = entry.label;
  $('result-desc').textContent = entry.description || (entry.isPrize ? 'Enjoy your little gift from PharmKulen.' : 'We hope you have a lovely day!');
  $('result-claim').hidden = !entry.code;
  $('claim-code').textContent = entry.code ?? '';
  $('copy-code').textContent = 'Copy';

  announce(
    entry.isPrize
      ? `Congratulations! You won ${entry.label}. Your claim code is ${entry.code.split('').join(' ')}.`
      : `Thank you for playing! You landed on ${entry.label}. ${entry.description}`,
  );

  dlg.showModal();
  if (entry.isPrize) {
    sound.win();
    if (!reducedMotion.matches) confetti($('confetti'));
  } else {
    sound.gentle();
  }
}

// ---------- events ----------
$('spin-btn').addEventListener('click', spin);
// Like classic spin-the-wheel apps, tapping the wheel itself spins it too.
$('wheel').addEventListener('click', spin);

$('spin-again').addEventListener('click', () => {
  if ($('spin-again').dataset.mode === 'next') {
    $('result-dialog').close(); // clears this player's details
    openDetails();
    return;
  }
  state.spinAgainPending = true;
  $('result-dialog').close();
  spin();
});

$('close-result').addEventListener('click', () => $('result-dialog').close());
$('result-dialog').addEventListener('close', () => {
  // A gift that just ran out may now be hidden: update the wheel once the result is out of the way.
  if (!state.spinning && !sameSegments(wheel.segments, state.game.segments)) wheel.setSegments(state.game.segments);
  // On a shared tablet, the next customer must enter their own details.
  if (!state.spinAgainPending && state.player) setPlayer(null);
  state.spinAgainPending = false;
  if (detailsDlg.open) return; // "Next player" moved focus into the form
  const btn = $('spin-btn');
  if (!btn.disabled) btn.focus({ preventScroll: true });
  else $('play').focus({ preventScroll: true });
});
// Click on the backdrop closes the dialog.
$('result-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

$('copy-code').addEventListener('click', async () => {
  const code = $('claim-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    $('copy-code').textContent = 'Copied!';
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('claim-code'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    $('copy-code').textContent = 'Selected';
  }
});

$('clear-history').addEventListener('click', () => {
  state.history = [];
  saveHistory();
  renderHistory();
  toast('Your spin history on this device was cleared.');
});

const soundBtn = $('sound-toggle');
function renderSound() {
  soundBtn.setAttribute('aria-pressed', String(sound.enabled));
  soundBtn.title = sound.enabled ? 'Sound on' : 'Sound off';
}
soundBtn.addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  localStorage.setItem(SOUND_KEY, sound.enabled ? 'on' : 'off');
  renderSound();
});

// ---------- player details ----------
const detailsDlg = $('details-dialog');
const fieldIds = { name: 'player-name-input', phone: 'player-phone-input' };

function showFieldErrors(errors = {}) {
  for (const [key, id] of Object.entries(fieldIds)) {
    const msg = errors[key] ?? '';
    $(`${key}-error`).textContent = msg;
    $(id).toggleAttribute('aria-invalid', !!msg);
    if (msg) $(id).setAttribute('aria-invalid', 'true');
  }
}

function openDetails(errors) {
  const p = state.player;
  if (p) {
    $('player-name-input').value = p.name;
    $('player-phone-input').value = p.phone;
  }
  $('details-error').textContent = '';
  $('details-submit').textContent = `Save & ${state.game?.branding.spinButtonLabel.toLowerCase() || 'spin'}`;
  showFieldErrors(errors);
  if (!detailsDlg.open) detailsDlg.showModal();
  const firstBad = errors && Object.keys(fieldIds).find((k) => errors[k]);
  (firstBad ? $(fieldIds[firstBad]) : $('player-name-input')).focus();
}

function checkDetails() {
  const name = $('player-name-input').value.replace(/\s+/g, ' ').trim();
  const phone = $('player-phone-input').value.trim().replace(/[\s\-.()]/g, '');
  const errors = {};
  if (name.length < 2) errors.name = 'Please enter your name.';
  if (!phone) errors.phone = 'Please enter your phone number.';
  else if (!/^\+?\d{6,15}$/.test(phone)) errors.phone = 'Please enter a valid phone number (digits only, e.g. 012 345 678).';
  return { name, phone, errors };
}

$('details-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { name, phone, errors } = checkDetails();
  showFieldErrors(errors);
  const firstBad = Object.keys(fieldIds).find((k) => errors[k]);
  if (firstBad) {
    $(fieldIds[firstBad]).focus();
    return;
  }
  setPlayer({ name, phone });
  detailsDlg.close();
  spin();
});
$('details-cancel').addEventListener('click', () => detailsDlg.close());
detailsDlg.addEventListener('close', () => {
  if (!state.spinning) $('spin-btn').focus({ preventScroll: true });
});
$('change-player').addEventListener('click', () => {
  setPlayer(null);
  openDetails();
});

// ---------- theme ----------
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

// ---------- full screen (great for a shop-counter display) ----------
const fsBtn = $('fullscreen-btn');
if (document.fullscreenEnabled) {
  fsBtn.hidden = false;
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('play').requestFullscreen().catch(() => toast('Full screen is not available here.', 'error'));
  });
  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement === $('play');
    fsBtn.setAttribute('aria-pressed', String(on));
    fsBtn.title = on ? 'Exit full screen' : 'Full screen';
  });
}

// Space bar spins when nothing interactive has focus.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || $('result-dialog').open || detailsDlg.open) return;
  const t = e.target;
  if (t !== document.body && t !== $('play') && t !== $('main')) return;
  e.preventDefault();
  spin();
});

// Keep availability fresh (staff may open/close the game).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.spinning) loadGame();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && !state.spinning && !$('result-dialog').open && !detailsDlg.open) loadGame();
}, 60_000);

// ---------- start ----------
try { localStorage.removeItem(OLD_PLAYER_KEY); } catch { /* ignore */ } // forget details saved by older versions
$('year').textContent = new Date().getFullYear();
renderSound();
renderTheme();
renderHistory();
if (state.history[0]) renderLatest(state.history[0]);
loadGame();
