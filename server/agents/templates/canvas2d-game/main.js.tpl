// {{Name}} — 2D canvas game with a FIXED-STEP loop (dt = 1/60, clamp 250 ms),
// input map, scene state machine, DPR-aware resize, pause on hidden tab.
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const STEP = 1 / 60;
const MAX_FRAME = 0.25;

let scene = 'boot';
const input = new Set();

addEventListener('keydown', (e) => input.add(e.key));
addEventListener('keyup', (e) => input.delete(e.key));

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

const player = { x: innerWidth / 2, y: innerHeight / 2, vx: 0, vy: 0 };

function update(dt) {
  if (input.has('ArrowLeft')) player.vx -= 240 * dt;
  if (input.has('ArrowRight')) player.vx += 240 * dt;
  if (input.has('ArrowUp')) player.vy -= 240 * dt;
  if (input.has('ArrowDown')) player.vy += 240 * dt;
  player.vx *= 0.9;
  player.vy *= 0.9;
  player.x += player.vx;
  player.y += player.vy;
  if (input.has('Enter') && scene === 'boot') scene = 'play';
}

function render() {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, innerWidth, innerHeight);
  ctx.fillStyle = scene === 'boot' ? '#888' : '#4af';
  ctx.beginPath();
  ctx.arc(player.x, player.y, 16, 0, Math.PI * 2);
  ctx.fill();
  if (scene === 'boot') {
    ctx.fillStyle = '#fff';
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('{{Name}} — press Enter', innerWidth / 2, innerHeight / 2 - 48);
  }
}

// dev-only probe hook for agent__game_probe
if (import.meta.env?.DEV) {
  window.__MORIKO_PROBE__ = { scene: () => scene, player: () => ({ ...player }) };
}

let last = performance.now();
let acc = 0;
let running = true;
document.addEventListener('visibilitychange', () => { running = !document.hidden; });

function frame(now) {
  requestAnimationFrame(frame);
  if (!running) { last = now; return; }
  acc += Math.min((now - last) / 1000, MAX_FRAME);
  last = now;
  while (acc >= STEP) {
    update(STEP);
    acc -= STEP;
  }
  render();
}
requestAnimationFrame(frame);
