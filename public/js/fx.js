// Celebration effects: tiny Web Audio sounds and logo-coloured confetti.
const COLORS = ['#19B2FF', '#62DBFF', '#44E4BC', '#11BD9B', '#058F9A'];

export class Sound {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
    this.lastTick = 0;
  }

  ensure() {
    if (!this.enabled) return null;
    try {
      this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.12 } = {}) {
    // Only play once a user gesture has unlocked audio (see ensure()).
    const ctx = this.ctx;
    if (!this.enabled || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  tick() {
    const now = performance.now();
    if (now - this.lastTick < 35) return; // avoid a buzz at top speed
    this.lastTick = now;
    this.tone(1400, { dur: 0.03, type: 'triangle', gain: 0.05 });
  }

  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, { at: i * 0.09, dur: 0.28, type: 'triangle', gain: 0.1 }));
  }

  gentle() {
    [587.33, 783.99].forEach((f, i) => this.tone(f, { at: i * 0.12, dur: 0.25, gain: 0.07 }));
  }
}

/** Burst of plus-shaped confetti, a nod to the PharmKulen cross. */
export function confetti(canvas, { count = 150, duration = 3600 } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const pieces = Array.from({ length: count }, (_, i) => {
    const fromLeft = i % 2 === 0;
    return {
      x: fromLeft ? -10 : innerWidth + 10,
      y: innerHeight * (0.45 + Math.random() * 0.3),
      vx: (fromLeft ? 1 : -1) * (5 + Math.random() * 9),
      vy: -(9 + Math.random() * 11),
      size: 6 + Math.random() * 8,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: COLORS[i % COLORS.length],
      shape: i % 3, // 0 plus, 1 pill, 2 dot
    };
  });

  const start = performance.now();
  return new Promise((resolve) => {
    const draw = (now) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const fade = Math.max(0, 1 - Math.max(0, elapsed - duration * 0.6) / (duration * 0.4));
      ctx.globalAlpha = fade;
      for (const p of pieces) {
        p.vy += 0.32;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        const s = p.size;
        if (p.shape === 0) {
          const w = s / 3;
          ctx.fillRect(-w / 2, -s / 2, w, s);
          ctx.fillRect(-s / 2, -w / 2, s, w);
        } else if (p.shape === 1) {
          ctx.beginPath();
          ctx.roundRect(-s / 2, -s / 4, s, s / 2, s / 4);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, s / 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (elapsed < duration) {
        requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        resolve();
      }
    };
    requestAnimationFrame(draw);
  });
}
