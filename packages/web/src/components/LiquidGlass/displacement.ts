/*
 * Liquid-glass displacement map — ported from the reference CodePen (see the plan's
 * Appendix A). Builds a rounded-rect SDF on an offscreen canvas where the R/G channels
 * encode x/y displacement, exported as a PNG data URL and cached by parameter key. The
 * SVG feDisplacementMap then refracts a cloned copy of the scene behind the lens.
 */

const BOOST = 0.8;
const mapCache = new Map<string, string>();

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function buildLensMap(
  mw: number,
  mh: number,
  winW: number,
  winH: number,
  radius: number,
  rim: number,
  curve: number,
  feather: number,
): string {
  const key = `${mw}:${winW}:${radius}:${rim}:${curve}:${feather}`;
  const hit = mapCache.get(key);
  if (hit) return hit;

  const cv = document.createElement('canvas');
  cv.width = mw;
  cv.height = mh;
  const ctx = cv.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(mw, mh);
  const px = img.data;

  const hx = winW / 2;
  const hy = winH / 2;
  const sdf = (x: number, y: number) => {
    const qx = Math.abs(x - mw / 2) - (hx - radius);
    const qy = Math.abs(y - mh / 2) - (hy - radius);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
  };

  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const s = sdf(cx, cy);
      const gx = sdf(cx + 1, cy) - sdf(cx - 1, cy);
      const gy = sdf(cx, cy + 1) - sdf(cx, cy - 1);
      const len = Math.hypot(gx, gy) || 1;
      const nx = gx / len;
      const ny = gy / len;
      const span = s < 0 ? rim + feather : rim;
      let amt = Math.max(0, 1 - Math.abs(s) / span);
      amt = amt * amt * amt * (amt * (amt * 6 - 15) + 10); // smootherstep
      amt = Math.pow(amt, curve);
      const i = (y * mw + x) * 4;
      px[i] = clamp255(Math.round(127.5 - nx * amt * 127 * BOOST)); // R = x displacement
      px[i + 1] = clamp255(Math.round(127.5 - ny * amt * 127 * BOOST)); // G = y displacement
      px[i + 2] = 128; // B unused — specular is a CSS overlay
      px[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const url = cv.toDataURL('image/png');
  if (mapCache.size > 300) {
    const first = mapCache.keys().next().value;
    if (first !== undefined) mapCache.delete(first);
  }
  mapCache.set(key, url);
  return url;
}
