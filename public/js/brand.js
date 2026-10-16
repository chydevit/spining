// The game's logo and icon: the PharmKulen originals, or images uploaded in Admin → Branding.
// Elements that show them carry data-brand="logo" / data-brand="icon"; CSS backgrounds use --brand-icon.
export const DEFAULT_LOGO = '/assets/pharmkulen-logo.png';
export const DEFAULT_ICON = '/assets/pharmkulen-icon.png';
export const DEFAULT_MARK = '/assets/pharmkulen-mark.png'; // the icon without its white square, for the background

let current = { logo: DEFAULT_LOGO, icon: DEFAULT_ICON, mark: DEFAULT_MARK };

export const brandIcon = () => current.icon;
export const brandLogo = () => current.logo;
export const brandMark = () => current.mark;

/** Apply branding ({ logo, icon }, null = default) to everything on the page, now and for machines built later. */
export function setBrand({ logo, icon } = {}) {
  current = { logo: logo || DEFAULT_LOGO, icon: icon || DEFAULT_ICON, mark: icon || DEFAULT_MARK };
  const root = document.documentElement;
  root.style.setProperty('--brand-icon', `url("${current.icon}")`);
  for (const el of document.querySelectorAll('[data-brand]')) {
    const src = current[el.dataset.brand] ?? current.icon;
    if (el.tagName.toLowerCase() === 'image') el.setAttribute('href', src); // SVG <image> (wheel hub)
    else if (el.getAttribute('src') !== src) el.setAttribute('src', src);
  }
}
