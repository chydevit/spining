// A company's logo and icon: images uploaded in Admin → Branding, or the defaults.
// Defaults: PharmKulen's artwork for the PharmKulen company; the Spin icon (and the company's
// name in place of a logo) for every other company.
// Elements that show them carry data-brand="logo" / "icon" / "mark"; CSS backgrounds use --brand-icon.
export const PHARMKULEN = {
  logo: '/assets/pharmkulen-logo.png',
  icon: '/assets/pharmkulen-icon.png',
  mark: '/assets/pharmkulen-mark.png', // the icon without its white square, for the background
};
export const GENERIC = { logo: null, icon: '/assets/spin-icon.svg', mark: '/assets/spin-icon.svg' };

let defaults = PHARMKULEN;
let companyName = 'PharmKulen';
let current = { ...PHARMKULEN };

export const brandIcon = () => current.icon;
export const brandLogo = () => current.logo;
export const brandMark = () => current.mark;
export const brandDefaults = () => defaults;

/** Which defaults apply ('pharmkulen' or 'generic') and the name shown when there is no logo. */
export function setCompany({ brand, name } = {}) {
  defaults = brand === 'pharmkulen' ? PHARMKULEN : GENERIC;
  document.documentElement.dataset.brandKind = brand === 'pharmkulen' ? 'pharmkulen' : 'generic';
  if (name) companyName = name;
}

/** Apply branding ({ logo, icon }, null = default) to everything on the page, now and for machines built later. */
export function setBrand({ logo, icon } = {}) {
  current = { logo: logo || defaults.logo, icon: icon || defaults.icon, mark: icon || defaults.mark };
  const root = document.documentElement;
  root.style.setProperty('--brand-icon', `url("${current.icon}")`);
  for (const el of document.querySelectorAll('[data-brand]')) {
    const kind = el.dataset.brand;
    if (kind === 'logo') {
      showLogo(el, current.logo);
      continue;
    }
    const src = current[kind] ?? current.icon;
    if (el.tagName.toLowerCase() === 'image') el.setAttribute('href', src); // SVG <image> (wheel hub)
    else if (el.getAttribute('src') !== src) el.setAttribute('src', src);
  }
}

/** A logo <img>, or — when the company has none — its icon and name as text in the same spot. */
function showLogo(img, src) {
  let text = img.nextElementSibling?.classList.contains('brand-text') ? img.nextElementSibling : null;
  if (src) {
    img.hidden = false;
    img.alt = companyName;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    if (text) text.hidden = true;
    return;
  }
  img.hidden = true;
  if (!text) {
    text = document.createElement('span');
    text.className = 'brand-text';
    const icon = document.createElement('img');
    icon.alt = '';
    icon.dataset.brand = 'icon';
    text.append(icon, document.createElement('span'));
    img.after(text);
  }
  text.hidden = false;
  text.firstElementChild.src = current.icon;
  text.lastElementChild.textContent = companyName;
}
