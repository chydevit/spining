// Landing page: a live demo wheel and a signed-in shortcut.
import { Spinner } from './spinner.js';
import { setCompany, setBrand } from './brand.js';

const $ = (id) => document.getElementById(id);

setCompany({ brand: 'generic', name: 'Spin' });
setBrand({});
const demo = [
  { label: 'Free Coffee', color: '#058F9A', isPrize: true },
  { label: 'Try Again', color: '#62DBFF', isPrize: false },
  { label: 'Tote Bag', color: '#11BD9B', isPrize: true },
  { label: 'Thank You', color: '#19B2FF', isPrize: false },
  { label: 'Sticker', color: '#44E4BC', isPrize: true },
  { label: 'Try Again', color: '#06636B', isPrize: false },
].map((s, i) => ({ id: `demo-${i}`, description: '', available: true, ...s }));

const wheel = new Spinner($('demo-wheel'), { label: 'Demo prize wheel', style: 'classic' });
wheel.setSegments(demo);

async function spin() {
  if (wheel.spinning) return;
  $('demo-spin').disabled = true;
  $('demo-result').textContent = '';
  const i = Math.floor(Math.random() * demo.length);
  await wheel.spinTo(i, { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  $('demo-result').textContent = demo[i].isPrize ? `You'd win: ${demo[i].label}! 🎉` : `${demo[i].label} — that's how your players will see it.`;
  $('demo-spin').disabled = false;
}
$('demo-spin').addEventListener('click', spin);
$('demo-wheel').addEventListener('click', spin);

fetch('/api/auth/session', { credentials: 'same-origin' })
  .then((r) => r.json())
  .then(({ user }) => {
    if (!user) return;
    $('nav-signed-out').hidden = true;
    $('nav-signed-in').hidden = false;
  })
  .catch(() => {});
