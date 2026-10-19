// Accounts and companies: validation, starter data and the move from the old single-company format.
import crypto from 'node:crypto';
import { newCompanyConfig } from './defaults.js';

export const MIN_PASSWORD_LENGTH = 8;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['admin', 'api', 'new', 'login', 'signup', 'account', 'assets', 'uploads', 'www', 'help', 'support']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

/** Turn a company name into a link-friendly id, e.g. "Pharm Kulen!" → "pharm-kulen". */
export function slugify(name) {
  return String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** Returns { errors: { name?, email?, password? }, user? } for sign-up input. */
export function validateSignup(input = {}) {
  const errors = {};
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  const email = normalizeEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  if (name.length < 2 || name.length > 60) errors.name = 'Please enter your name (2–60 characters).';
  if (!EMAIL_RE.test(email) || email.length > 120) errors.email = 'Please enter a valid email address.';
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
  return { errors, name, email, password };
}

export function validateEmail(email) {
  const e = normalizeEmail(email);
  return EMAIL_RE.test(e) && e.length <= 120 ? e : null;
}

/** Returns { errors: { name?, slug? }, name, slug } for a new or renamed company. */
export function validateCompany(input = {}, { slugTaken = () => false } = {}) {
  const errors = {};
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  const slug = String(input.slug ?? '').trim().toLowerCase() || slugify(name);
  if (name.length < 2 || name.length > 60) errors.name = 'Please enter the company name (2–60 characters).';
  if (!SLUG_RE.test(slug)) errors.slug = 'Use 3–40 lowercase letters, numbers or dashes (no dash at the start or end).';
  else if (RESERVED.has(slug)) errors.slug = 'That link is reserved. Please choose another.';
  else if (slugTaken(slug)) errors.slug = 'That link is already taken. Please choose another.';
  return { errors, name, slug };
}

export const ROLES = ['superadmin', 'admin', 'staff', 'user'];
export const ROLE_LABELS = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  staff: 'Staff',
  user: 'User',
};

export function validateRole(role) {
  return ROLES.includes(role) ? role : null;
}

export function newUser({ name, email, password, role = 'admin' }) {
  return { id: crypto.randomUUID(), email, name, password, role, createdAt: new Date().toISOString() };
}

export function newCompany({ name, slug, ownerId, brand = 'generic', config = null, configUpdatedAt = null }) {
  return {
    id: crypto.randomUUID(),
    slug,
    name,
    ownerId,
    brand, // 'pharmkulen' = PharmKulen artwork as the default logo/icon; 'generic' = the Spin icon + company name
    config: config ?? newCompanyConfig(name),
    configUpdatedAt,
    createdAt: new Date().toISOString(),
    spins: [],
  };
}

/**
 * The app used to run one game with one admin password. That data becomes the first company
 * ("PharmKulen") owned by an account whose email is OWNER_EMAIL (default admin@pharmkulen.local)
 * and whose password is the old admin password.
 */
export function legacyToTenancy({ config, configUpdatedAt, admin }) {
  const user = newUser({
    name: 'PharmKulen admin',
    email: normalizeEmail(process.env.OWNER_EMAIL) || 'admin@pharmkulen.local',
    password: admin.password,
    role: 'superadmin',
  });
  const company = newCompany({ name: 'PharmKulen', slug: 'pharmkulen', ownerId: user.id, brand: 'pharmkulen', config, configUpdatedAt });
  return { user, company };
}

