// Minimal pixel-accurate stand-in for a canvas + 2D context, for Node tests.
// Supports what src/renderer.js uses: fillStyle (#rgb, #rrggbb, rgba()),
// globalAlpha, fillRect, clearRect, drawImage(src, x, y), imageSmoothingEnabled.
// Compositing is source-over with straight alpha.

function parseColor(style) {
  if (style.startsWith('#')) {
    const hex = style.length === 4 ? [...style.slice(1)].map((c) => c + c).join('') : style.slice(1);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(1);
  }
  const m = style.match(/^rgba?\(([^)]+)\)$/);
  if (!m) throw new Error(`unsupported color ${style}`);
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return [r, g, b, a];
}

export function createFakeCanvas(width, height, log = null) {
  const data = new Float64Array(width * height * 4);    // r, g, b in 0–255; a in 0–1

  function blend(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= width || y >= height || a <= 0) return;
    const i = (y * width + x) * 4;
    const da = data[i + 3];
    const oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) {
      const s = [r, g, b][c];
      data[i + c] = oa === 0 ? 0 : (s * a + data[i + c] * da * (1 - a)) / oa;
    }
    data[i + 3] = oa;
  }

  const ctx = {
    fillStyle: '#000000',
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    fillRect(x, y, w, h) {
      const [r, g, b, a] = parseColor(ctx.fillStyle);
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) blend(xx, yy, r, g, b, a * ctx.globalAlpha);
      log?.push(['fillRect', x, y, w, h]);
    },
    clearRect(x, y, w, h) {
      for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) data.fill(0, (yy * width + xx) * 4, (yy * width + xx) * 4 + 4);
      }
    },
    drawImage(src, dx, dy) {
      if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error(`non-integer drawImage at ${dx},${dy}`);
      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
          const [r, g, b, a] = src.pixel(x, y);
          blend(dx + x, dy + y, r, g, b, a * ctx.globalAlpha);
        }
      }
      log?.push(['drawImage', dx, dy]);
    },
  };

  return {
    width,
    height,
    getContext: () => ctx,
    /** @returns {[r, g, b, a]} a in 0–1, channels rounded */
    pixel(x, y) {
      const i = (y * width + x) * 4;
      return [Math.round(data[i]), Math.round(data[i + 1]), Math.round(data[i + 2]), Math.round(data[i + 3] * 1000) / 1000];
    },
    /** Bounding box [minX, minY, maxX, maxY] of pixels with alpha > 0 in a region, or null. */
    bounds(x0 = 0, y0 = 0, w = width, h = height) {
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          if (data[(y * width + x) * 4 + 3] > 0) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
      }
      return maxX < 0 ? null : [minX, minY, maxX, maxY];
    },
  };
}

export const hex = (style) => parseColor(style).slice(0, 3);
