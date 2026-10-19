// "My companies": list, create, rename and delete companies, and edit the account.
// Includes Super Admin console for managing all users, roles, and companies across Spin.
const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  companies: [],
  slugEdited: false,
  renaming: null,
  deleting: null,
  superUsers: [],
  superCompanies: [],
  superStats: null,
  activeTab: 'companies',
  roleUser: null,
  superPwUser: null,
  transferCompany: null,
  deleteTargetUser: null,
};

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function toast(message, kind = 'success') {
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', { text: message }));
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.replace(`/login?next=${encodeURIComponent('/account')}`);
    throw new Error('Please sign in.');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { data, status: res.status });
  return data;
}

const gameUrl = (slug) => `${location.origin}/c/${slug}`;
const fmt = (n) => new Intl.NumberFormat().format(n);

/** Same rules as the server (src/tenancy.js). */
function slugify(name) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}

function rolePill(role) {
  const labels = { superadmin: '👑 Super Admin', admin: 'Admin', staff: 'Staff', user: 'User' };
  const classes = { superadmin: 'pill-super', admin: 'pill-admin', staff: 'pill-staff', user: 'pill-user' };
  return h('span', { class: `pill pill-plain ${classes[role] || 'pill-user'}`, text: labels[role] || role });
}

// ---------- tabs switcher ----------
function switchTab(tab) {
  state.activeTab = tab;
  const isSuper = tab === 'super';
  $('tab-my-companies').classList.toggle('active', !isSuper);
  $('tab-super-admin').classList.toggle('active', isSuper);
  $('view-companies').hidden = isSuper;
  $('view-super').hidden = !isSuper;
  if (isSuper) {
    location.hash = 'super';
    loadSuperData();
  } else {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

$('tab-my-companies').addEventListener('click', () => switchTab('companies'));
$('tab-super-admin').addEventListener('click', () => switchTab('super'));
$('refresh-super').addEventListener('click', () => {
  toast('Refreshing data…');
  loadSuperData();
});

// ---------- companies ----------
function companyIcon(c) {
  return c.icon || (c.brand === 'pharmkulen' ? '/assets/pharmkulen-icon.png' : '/assets/spin-icon.svg');
}

function renderCompanies() {
  const list = state.companies;
  $('no-companies').hidden = list.length > 0;
  $('companies').replaceChildren(...list.map((c) => {
    const copy = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Copy', 'aria-label': `Copy link to ${c.name}'s game` });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(gameUrl(c.slug));
        copy.textContent = 'Copied!';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      } catch {
        toast('Copy failed. Select the link and copy it yourself.', 'error');
      }
    });
    return h('article', { class: 'card company', 'aria-label': c.name },
      h('div', { class: 'company-top' },
        h('img', { src: companyIcon(c), alt: '', width: 52, height: 52 }),
        h('div', {},
          h('div', { class: 'company-name', text: c.name }),
          h('span', { class: `pill ${c.open ? 'pill-success' : 'pill-warning'}`, text: c.open ? 'Open' : 'Closed' }),
        ),
      ),
      h('div', { class: 'company-link' }, h('span', { text: `/c/${c.slug}` }), copy),
      h('div', { class: 'company-stats' },
        h('span', {}, h('strong', { text: fmt(c.spinsToday) }), ' spins today'),
        h('span', {}, h('strong', { text: fmt(c.spins) }), ' in total'),
      ),
      h('div', { class: 'company-actions' },
        h('a', { class: 'btn btn-primary btn-sm', href: `/c/${c.slug}/admin` }, 'Customise & admin'),
        h('a', { class: 'btn btn-secondary btn-sm', href: `/c/${c.slug}`, target: '_blank', rel: 'noopener' }, 'Play'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Rename', onclick: () => openRename(c) }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Delete', onclick: () => openDelete(c) }),
      ),
    );
  }));
}

async function loadCompanies() {
  const { companies } = await api('/api/companies');
  state.companies = companies;
  renderCompanies();
}

// ---------- create ----------
let slugTimer;
function setSlugStatus(text, kind = '') {
  const el = $('c-slug-status');
  el.textContent = text;
  el.className = `slug-status ${kind ? `slug-${kind}` : ''}`;
}

async function checkSlug(slug) {
  if (!slug) return setSlugStatus('');
  setSlugStatus('checking…');
  try {
    const { available, error } = await api(`/api/companies/check-slug?slug=${encodeURIComponent(slug)}`);
    if (error) setSlugStatus(error, 'bad');
    else if (available) setSlugStatus('Available', 'ok');
    else setSlugStatus('Already taken', 'bad');
  } catch {
    setSlugStatus('');
  }
}

$('c-name').addEventListener('input', (e) => {
  if (state.slugEdited) return;
  const s = slugify(e.target.value);
  $('c-slug').value = s;
  clearTimeout(slugTimer);
  slugTimer = setTimeout(() => checkSlug(s), 250);
});

$('c-slug').addEventListener('input', (e) => {
  state.slugEdited = true;
  clearTimeout(slugTimer);
  const s = e.target.value.trim().toLowerCase();
  slugTimer = setTimeout(() => checkSlug(s), 250);
});

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('c-name-error').textContent = '';
  setSlugStatus('');
  const name = $('c-name').value.trim();
  const slug = $('c-slug').value.trim().toLowerCase();
  try {
    const { company } = await api('/api/companies', { method: 'POST', body: { name, slug } });
    location.assign(`/c/${company.slug}/admin`);
  } catch (err) {
    if (err.data?.fields?.name) $('c-name-error').textContent = err.data.fields.name;
    if (err.data?.fields?.slug) setSlugStatus(err.data.fields.slug, 'bad');
    if (!err.data?.fields) toast(err.message, 'error');
  }
});

// ---------- rename ----------
function openRename(c) {
  state.renaming = c;
  $('rename-name').value = c.name;
  $('rename-error').textContent = '';
  $('rename-dialog').showModal();
  $('rename-name').focus();
}
$('rename-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('rename-error').textContent = '';
  const name = $('rename-name').value.trim();
  try {
    await api(`/api/companies/${state.renaming.slug}`, { method: 'PUT', body: { name } });
    $('rename-dialog').close();
    toast('Company renamed.');
    loadCompanies();
    if (state.user?.role === 'superadmin') loadSuperData();
  } catch (err) {
    $('rename-error').textContent = err.message;
  }
});

// ---------- delete company ----------
function openDelete(c) {
  state.deleting = c;
  $('delete-name').textContent = c.name;
  $('delete-slug').textContent = c.slug;
  $('delete-confirm').value = '';
  $('delete-submit').disabled = true;
  $('delete-error').textContent = '';
  $('delete-dialog').showModal();
  $('delete-confirm').focus();
}
$('delete-confirm').addEventListener('input', () => {
  $('delete-submit').disabled = $('delete-confirm').value.trim() !== state.deleting?.slug;
});
$('delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/api/companies/${state.deleting.slug}`, { method: 'DELETE', body: { confirm: $('delete-confirm').value.trim() } });
    $('delete-dialog').close();
    toast(`${state.deleting.name} was deleted.`);
    loadCompanies();
    if (state.user?.role === 'superadmin') loadSuperData();
  } catch (err) {
    $('delete-error').textContent = err.message;
  }
});

// ---------- super admin: users & roles ----------
async function loadSuperData() {
  try {
    const [stats, usersData, companiesData] = await Promise.all([
      api('/api/super/stats'),
      api('/api/super/users'),
      api('/api/super/companies'),
    ]);
    state.superStats = stats;
    state.superUsers = usersData.users;
    state.superCompanies = companiesData.companies;
    renderSuperStats();
    renderSuperUsers();
    renderSuperCompanies();
  } catch (err) {
    toast(`Failed to load Super Admin data: ${err.message}`, 'error');
  }
}

function renderSuperStats() {
  const s = state.superStats;
  if (!s) return;
  $('stat-users').textContent = fmt(s.totalUsers);
  const rc = s.roleCounts || {};
  $('stat-roles-breakdown').textContent = `${rc.superadmin || 0} super admin, ${rc.admin || 0} admin, ${rc.staff || 0} staff, ${rc.user || 0} user`;
  $('stat-companies').textContent = fmt(s.totalCompanies);
  $('stat-spins-today').textContent = fmt(s.totalSpinsToday);
  $('stat-spins-total').textContent = fmt(s.totalSpins);
}

function renderSuperUsers() {
  const q = ($('user-search').value || '').trim().toLowerCase();
  const roleFilter = $('user-role-filter').value;
  const list = state.superUsers.filter((u) => {
    if (roleFilter && u.role !== roleFilter) return false;
    if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
    return true;
  });

  const tbody = $('super-users-table');
  if (!list.length) {
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: 5, style: 'text-align:center; padding: 24px; color: var(--ink-3);', text: 'No users match your search.' })));
    return;
  }

  tbody.replaceChildren(...list.map((u) => {
    const isSelf = u.id === state.user.id;
    const isSoleSuper = u.role === 'superadmin' && state.superUsers.filter((x) => x.role === 'superadmin').length <= 1;

    const roleBtn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Role', onclick: () => openRoleDialog(u) });
    const pwBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Password', onclick: () => openSuperPwDialog(u) });
    const delBtn = h('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      text: 'Delete',
      disabled: isSelf || isSoleSuper,
      title: isSelf ? 'You cannot delete yourself' : (isSoleSuper ? 'Cannot delete the only Super Admin' : 'Delete user account'),
      onclick: () => openDeleteUserDialog(u),
    });

    const comps = u.companies.length
      ? h('div', { style: 'display:flex; flex-wrap:wrap; gap:4px;' }, ...u.companies.map((c) =>
          h('a', { href: `/c/${c.slug}/admin`, class: 'pill pill-plain', style: 'font-size:12px; font-weight:700;', text: c.name })
        ))
      : h('span', { style: 'color:var(--ink-3); font-size:13px;', text: 'None' });

    return h('tr', {},
      h('td', {},
        h('div', { class: 'user-cell' },
          h('strong', {}, u.name, isSelf ? ' (You)' : ''),
          h('span', { text: u.email }),
        ),
      ),
      h('td', {}, rolePill(u.role)),
      h('td', {}, comps),
      h('td', { style: 'color:var(--ink-2); font-size:13px;', text: u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—' }),
      h('td', { class: 'actions-col' },
        h('div', { class: 'actions-wrap' }, roleBtn, pwBtn, delBtn),
      ),
    );
  }));
}

$('user-search').addEventListener('input', renderSuperUsers);
$('user-role-filter').addEventListener('change', renderSuperUsers);

function renderSuperCompanies() {
  const q = ($('company-search').value || '').trim().toLowerCase();
  const list = state.superCompanies.filter((c) => {
    if (!q) return true;
    const nameMatch = c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q);
    const ownerMatch = c.owner ? (c.owner.name.toLowerCase().includes(q) || c.owner.email.toLowerCase().includes(q)) : false;
    return nameMatch || ownerMatch;
  });

  const tbody = $('super-companies-table');
  if (!list.length) {
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: 6, style: 'text-align:center; padding: 24px; color: var(--ink-3);', text: 'No companies match your search.' })));
    return;
  }

  tbody.replaceChildren(...list.map((c) => {
    const adminLink = h('a', { class: 'btn btn-primary btn-sm', href: `/c/${c.slug}/admin` }, 'Admin');
    const playLink = h('a', { class: 'btn btn-secondary btn-sm', href: `/c/${c.slug}`, target: '_blank', rel: 'noopener' }, 'Play');
    const transferBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Transfer', onclick: () => openTransferDialog(c) });
    const deleteBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Delete', onclick: () => openDelete(c) });

    const ownerCell = c.owner
      ? h('div', { class: 'user-cell' },
          h('strong', {}, c.owner.name),
          h('span', { text: c.owner.email }),
        )
      : h('span', { style: 'color:var(--ink-3);', text: 'Unassigned' });

    return h('tr', {},
      h('td', {},
        h('div', { class: 'company-cell' },
          h('img', { src: companyIcon(c), alt: '', width: 32, height: 32 }),
          h('div', { class: 'company-cell-info' },
            h('span', { class: 'company-cell-name', text: c.name }),
            h('span', { class: 'company-cell-slug', text: `/c/${c.slug}` }),
          ),
        ),
      ),
      h('td', {}, ownerCell),
      h('td', {}, h('span', { class: `pill ${c.open ? 'pill-success' : 'pill-warning'}`, text: c.open ? 'Open' : 'Closed' })),
      h('td', { class: 'num' }, fmt(c.spinsToday)),
      h('td', { class: 'num' }, fmt(c.spins)),
      h('td', { class: 'actions-col' },
        h('div', { class: 'actions-wrap' }, adminLink, playLink, transferBtn, deleteBtn),
      ),
    );
  }));
}

$('company-search').addEventListener('input', renderSuperCompanies);

// ---------- dialog: change role ----------
function openRoleDialog(u) {
  state.roleUser = u;
  $('role-user-name').textContent = u.name;
  $('role-user-email').textContent = u.email;
  $('role-error').textContent = '';

  const currentRole = u.role || 'admin';
  document.querySelectorAll('#role-form input[name="targetRole"]').forEach((radio) => {
    radio.checked = radio.value === currentRole;
    radio.closest('.role-radio-card')?.classList.toggle('selected', radio.checked);
  });

  $('role-dialog').showModal();
}

document.querySelectorAll('#role-form input[name="targetRole"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('#role-form .role-radio-card').forEach((card) => {
      card.classList.toggle('selected', card.querySelector('input').checked);
    });
  });
});

$('role-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('role-error').textContent = '';
  const selected = document.querySelector('#role-form input[name="targetRole"]:checked')?.value;
  if (!selected) return;

  try {
    const { user } = await api(`/api/super/users/${state.roleUser.id}/role`, { method: 'PUT', body: { role: selected } });
    $('role-dialog').close();
    toast(`Updated ${user.name}'s role to ${selected}.`);
    if (state.user && state.user.id === user.id) {
      state.user.role = user.role;
      renderUser();
    }
    loadSuperData();
  } catch (err) {
    $('role-error').textContent = err.message;
  }
});

// ---------- dialog: reset user password ----------
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function openSuperPwDialog(u) {
  state.superPwUser = u;
  $('super-pw-user').textContent = `${u.name} (${u.email})`;
  $('super-pw-input').value = generatePassword();
  $('super-pw-error').textContent = '';
  $('super-pw-dialog').showModal();
  $('super-pw-input').focus();
}

$('super-pw-gen').addEventListener('click', () => {
  $('super-pw-input').value = generatePassword();
});

$('super-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('super-pw-error').textContent = '';
  const newPassword = $('super-pw-input').value.trim();
  if (newPassword.length < 8) {
    $('super-pw-error').textContent = 'Password must be at least 8 characters.';
    return;
  }

  try {
    await api(`/api/super/users/${state.superPwUser.id}/reset-password`, { method: 'POST', body: { newPassword } });
    $('super-pw-dialog').close();
    toast(`Password updated for ${state.superPwUser.email}.`);
  } catch (err) {
    $('super-pw-error').textContent = err.message;
  }
});

// ---------- dialog: transfer ownership ----------
function openTransferDialog(c) {
  state.transferCompany = c;
  $('transfer-company-name').textContent = c.name;
  $('transfer-company-slug').textContent = `/c/${c.slug}`;
  $('transfer-error').textContent = '';

  const select = $('transfer-owner-select');
  select.replaceChildren(...state.superUsers.map((u) => {
    const opt = h('option', { value: u.id, text: `${u.name} (${u.email}) [${u.role}]` });
    if (u.id === c.ownerId) opt.selected = true;
    return opt;
  }));

  $('transfer-dialog').showModal();
}

$('transfer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('transfer-error').textContent = '';
  const newOwnerId = $('transfer-owner-select').value;
  if (!newOwnerId) return;

  try {
    await api(`/api/super/companies/${state.transferCompany.slug}/owner`, { method: 'PUT', body: { ownerId: newOwnerId } });
    $('transfer-dialog').close();
    toast(`Ownership of ${state.transferCompany.name} transferred.`);
    loadCompanies();
    loadSuperData();
  } catch (err) {
    $('transfer-error').textContent = err.message;
  }
});

// ---------- dialog: delete user ----------
function openDeleteUserDialog(u) {
  state.deleteTargetUser = u;
  $('super-del-email').textContent = `${u.name} (${u.email})`;
  $('super-del-confirm-text').textContent = u.email;
  $('super-del-confirm').value = '';
  $('super-del-submit').disabled = true;
  $('super-del-error').textContent = '';
  $('super-delete-user-dialog').showModal();
  $('super-del-confirm').focus();
}

$('super-del-confirm').addEventListener('input', (e) => {
  const val = e.target.value.trim();
  $('super-del-submit').disabled = val !== state.deleteTargetUser?.email && val !== 'DELETE';
});

$('super-delete-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('super-del-error').textContent = '';
  const confirm = $('super-del-confirm').value.trim();
  try {
    await api(`/api/super/users/${state.deleteTargetUser.id}`, { method: 'DELETE', body: { confirm } });
    $('super-delete-user-dialog').close();
    toast(`Account for ${state.deleteTargetUser.email} was deleted.`);
    loadSuperData();
    loadCompanies();
  } catch (err) {
    $('super-del-error').textContent = err.message;
  }
});

// ---------- generic dialog close button handling ----------
document.querySelectorAll('dialog [data-close]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.target.closest('dialog')?.close();
  });
});

// ---------- account settings ----------
function renderUser() {
  $('who').textContent = state.user.name;
  const role = state.user.role || 'admin';
  const badge = $('role-badge');
  badge.textContent = role === 'superadmin' ? '👑 Super Admin' : (role === 'staff' ? 'Staff' : (role === 'user' ? 'User' : 'Admin'));
  badge.className = `pill pill-plain role-badge ${role === 'superadmin' ? 'pill-super' : (role === 'staff' ? 'pill-staff' : 'pill-admin')}`;
  badge.hidden = false;

  $('p-name').value = state.user.name;
  $('p-email').value = state.user.email;

  if (role === 'superadmin') {
    $('account-tabs').hidden = false;
  }
}

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('p-error').textContent = '';
  try {
    const { user } = await api('/api/auth/profile', { method: 'PUT', body: { name: $('p-name').value, email: $('p-email').value } });
    state.user = user;
    renderUser();
    toast('Profile saved.');
    if (state.user.role === 'superadmin') loadSuperData();
  } catch (err) {
    $('p-error').textContent = err.message;
  }
});

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pw-error').textContent = '';
  if ($('pw-new').value.length < 8) {
    $('pw-error').textContent = 'Use at least 8 characters for the new password.';
    return $('pw-new').focus();
  }
  try {
    await api('/api/auth/password', { method: 'POST', body: { currentPassword: $('pw-current').value, newPassword: $('pw-new').value } });
    e.target.reset();
    toast('Password changed. Other devices were signed out.');
  } catch (err) {
    $('pw-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  location.assign('/login?signedout=1');
});

// ---------- start ----------
(async function init() {
  const { user } = await (await fetch('/api/auth/session', { credentials: 'same-origin' })).json();
  if (!user) return location.replace(`/login?next=${encodeURIComponent('/account')}`);
  state.user = user;
  renderUser();

  const host = document.createElement('span');
  host.className = 'slug-host';
  host.textContent = location.host;
  $('slug-prefix').replaceChildren(host, '/c/');
  $('main').hidden = false;

  if (new URLSearchParams(location.search).get('welcome')) {
    $('welcome').hidden = false;
    $('c-name').focus();
  }

  await loadCompanies();

  if (state.user.role === 'superadmin' && location.hash === '#super') {
    switchTab('super');
  }
})();
