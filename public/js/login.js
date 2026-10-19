// Sign in / create an account. Afterwards go to ?next=… (same site only) or "My companies".
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const next = (() => {
  const n = params.get('next') ?? '';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/account';
})();

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { data });
  return data;
}

function busy(btn, on, label) {
  btn.disabled = on;
  btn.textContent = on ? 'Please wait…' : label;
}

// ----- tabs -----
const tabs = { login: $('tab-login'), signup: $('tab-signup') };
function show(which, { focus = true } = {}) {
  for (const [name, tab] of Object.entries(tabs)) {
    const active = name === which;
    tab.setAttribute('aria-selected', String(active));
    $(`${name}-form`).hidden = !active;
  }
  $('auth-title').textContent = which === 'signup' ? 'Create your account' : 'Welcome back';
  document.title = `${which === 'signup' ? 'Create account' : 'Sign in'} · Spin`;
  history.replaceState(null, '', (which === 'signup' ? '/signup' : '/login') + location.search);
  if (focus) $(which === 'signup' ? 'signup-name' : 'login-email').focus();
}
tabs.login.addEventListener('click', () => show('login'));
tabs.signup.addEventListener('click', () => show('signup'));
show(location.pathname === '/signup' || location.hash === '#signup' ? 'signup' : 'login', { focus: false });

if (params.get('signedout')) {
  $('auth-notice').hidden = false;
  $('auth-notice').textContent = 'You have signed out.';
}

// Already signed in? Go straight on.
fetch('/api/auth/session', { credentials: 'same-origin' })
  .then((r) => r.json())
  .then(({ user }) => { if (user && !params.get('signedout')) location.replace(next); })
  .catch(() => {});

// ----- sign in -----
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('login-email');
  const pw = $('login-password');
  $('login-error').textContent = '';
  if (!email.value.trim() || !pw.value) {
    $('login-error').textContent = 'Enter your email and password.';
    (email.value.trim() ? pw : email).focus();
    return;
  }
  busy($('login-submit'), true);
  try {
    await post('/api/auth/login', { email: email.value, password: pw.value });
    location.assign(next);
  } catch (err) {
    $('login-error').textContent = err.message;
    pw.select();
    busy($('login-submit'), false, 'Sign in');
  }
});

// ----- create account -----
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = { name: $('signup-name'), email: $('signup-email'), password: $('signup-password') };
  for (const [k, input] of Object.entries(fields)) {
    $(`signup-${k}-error`).textContent = '';
    input.removeAttribute('aria-invalid');
  }
  $('signup-error').textContent = '';
  busy($('signup-submit'), true);
  try {
    await post('/api/auth/signup', { name: fields.name.value, email: fields.email.value, password: fields.password.value });
    location.assign(next === '/account' ? '/account?welcome=1' : next);
  } catch (err) {
    const bad = err.data?.fields ?? {};
    let first = null;
    for (const [k, msg] of Object.entries(bad)) {
      if (!fields[k]) continue;
      $(`signup-${k}-error`).textContent = msg;
      fields[k].setAttribute('aria-invalid', 'true');
      first ??= fields[k];
    }
    if (!first) $('signup-error').textContent = err.message;
    (first ?? fields.name).focus();
    busy($('signup-submit'), false, 'Create account');
  }
});
