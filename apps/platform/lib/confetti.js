// Dependency-free confetti — no npm package (so it never needs an install on
// the deploy box). Spawns a transient full-screen canvas, bursts colored
// particles, and removes itself when the animation finishes. Used for the
// "you're live" go-live celebration in the admin shell.

export function fireConfetti(opts = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  // Respect reduced-motion preference — no surprise animation.
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch {}

  const {
    particleCount = 170,
    durationMs = 2800,
    origins = [{ x: 0.5, y: 0.42 }], // burst point(s), fraction of viewport
  } = opts;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483600';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function size() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();

  const colors = ['#6366F1', '#22C55E', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899', '#14B8A6', '#FACC15'];
  const parts = [];
  origins.forEach((o) => {
    const cx = window.innerWidth * o.x;
    const cy = window.innerHeight * o.y;
    const per = Math.ceil(particleCount / origins.length);
    for (let i = 0; i < per; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = 6 + Math.random() * 10;
      parts.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity - 5, // slight upward pop, like a cracker
        g: 0.16 + Math.random() * 0.12,
        w: 5 + Math.random() * 7,
        h: 4 + Math.random() * 6,
        color: colors[(Math.random() * colors.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
      });
    }
  });

  const start = performance.now();
  function frame(now) {
    const t = now - start;
    const life = Math.max(0, 1 - t / durationMs);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    parts.forEach((p) => {
      p.vy += p.g;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = life;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (t < durationMs) {
      requestAnimationFrame(frame);
    } else {
      window.removeEventListener('resize', size);
      canvas.remove();
    }
  }
  window.addEventListener('resize', size);
  requestAnimationFrame(frame);
}
