// 里程碑慶祝彩帶:全螢幕 canvas 疊層,粒子落完自動移除。

const COLORS = ["#3b82f6", "#93c5fd", "#22c55e", "#f59e0b", "#ec4899", "#a78bfa"];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  spin: number;
}

let running = false;

export function launchConfetti(durationMs = 2800): void {
  if (running) return; // 同時只跑一場
  running = true;

  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  const particles: Particle[] = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    vx: (Math.random() - 0.5) * 2.5,
    vy: 2 + Math.random() * 3,
    size: 5 + Math.random() * 5,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.25,
  }));

  const start = performance.now();

  function frame(now: number): void {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      // 收尾階段淡出
      ctx.globalAlpha = Math.max(0, Math.min(1, (durationMs - elapsed) / 600));
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }

    if (elapsed < durationMs) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
      running = false;
    }
  }
  requestAnimationFrame(frame);
}
