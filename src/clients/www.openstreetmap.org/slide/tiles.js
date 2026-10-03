/**
 * Strava heatmap tiles -> a georeferenced Slide surface.
 *
 * Fetches the z14 heatmap tiles covering a bounding box, stitches them into a
 * single canvas and hands the Slide engine a `Surface` built from the pixels.
 *
 * Tile pixel size is whatever the server sends (512 or 1024 px), so the cell
 * size is always derived from the image that actually arrived:
 *
 *     cell = ground size of one z14 tile / pixels per tile
 *          = (earth circumference / 2^z) / pixels per tile
 *
 * Coordinates are Web-Mercator metres measured from the top-left corner of
 * the stitched canvas, y growing downwards — the same convention as jsSlide's
 * `src/main.js`, so `surface.js`/`slide.js` work unchanged.
 *
 * Tile requests rely on the extension's declarativeNetRequest rule (see
 * src/background/rules.js) which injects the Strava cookies and an
 * `Access-Control-Allow-Origin: *` response header. When that path fails
 * (CORS or page CSP), the request is proxied through the background service
 * worker instead, which is not subject to either.
 */

import { Surface, SmoothSurface, buildKernel, colorValue } from './surface.js';

const R = 6378137; // Earth radius in metres (Web Mercator)
const EARTH_C = 2 * Math.PI * R; // circumference at the equator

/** Heatmap tiles are requested at z14, the zoom level jsSlide validated. */
export const TILE_Z = 14;
const N = 2 ** TILE_Z;

/** Never fetch more than 3x3 tiles for one line (~7.3 km at z14). */
export const MAX_TILE_COLS = 3;
export const MAX_TILE_ROWS = 3;

/**
 * Stitched canvas edge cap. `Surface` plus the two `SmoothSurface` caches
 * keep three Float64Arrays of width*height, so 2048^2 is ~100 MB peak.
 * Bigger stitched areas are drawn down-scaled instead of refused.
 */
export const MAX_EDGE_PX = 2048;

const HEATMAP_PATH_RE = /\/identified\/globalheat\//;
const TILE_FETCH_TIMEOUT_MS = 20000;

function tileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Read a background source's URL template. iD's `rendererBackgroundSource()`
 * exposes `template` as an accessor function (`source.template()` returns
 * the raw string), while plain config objects carry it as a string.
 */
function templateOf(layer) {
  const template =
    typeof layer.template === 'function' ? layer.template() : layer.template;
  return typeof template === 'string' ? template : null;
}

/**
 * The URL template of the Strava heatmap overlay the user has switched on,
 * or null when none is enabled. The activity/color pair of the operation
 * comes from here, mirroring strava/iD's `heatType()`.
 */
export function enabledHeatmapTemplate(context) {
  try {
    const overlays = context.background().overlayLayerSources();
    const source = overlays.find((layer) => {
      if (typeof layer.id !== 'string' || !layer.id.startsWith('strava-heatmap-')) {
        return false;
      }
      const template = templateOf(layer);
      return Boolean(template) && HEATMAP_PATH_RE.test(template);
    });
    return source ? templateOf(source) : null;
  } catch (error) {
    console.warn('[StravaHeatmapExt] Could not read overlay sources', error);
    return null;
  }
}

/** x index of the z14 tile containing `lon`. */
export function lonToTileX(lon) {
  const x = Math.floor(((lon + 180) / 360) * N);
  return Math.min(N - 1, Math.max(0, x));
}

/** y index of the z14 tile containing `lat` (clamped to the Mercator limit). */
export function latToTileY(lat) {
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * N
  );
  return Math.min(N - 1, Math.max(0, y));
}

/**
 * Tiles covering `locs` (array of [lon, lat]), or null when the line would
 * need more than 3x3 tiles — checked synchronously so the menu item can be
 * shown disabled instead of failing on click.
 */
export function tileRange(locs) {
  if (!locs || locs.length < 2) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const [lon, lat] of locs) {
    const x = lonToTileX(lon);
    const y = latToTileY(lat);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  if (cols > MAX_TILE_COLS || rows > MAX_TILE_ROWS) return null;

  return { minX, minY, cols, rows };
}

/**
 * Georeferencing for a stitched canvas whose top-left corner sits at the
 * top-left of tile (minX, minY) and whose pixels are `cell` metres wide.
 *
 *   toSurface([lon, lat]) -> [mx, my]   metres from the canvas' top-left
 *   toLoc(mx, my)         -> [lon, lat]
 */
export function makeGeoref(minX, minY, cell) {
  const left = (minX / N) * EARTH_C - EARTH_C / 2; // metres east of the prime meridian
  const top = EARTH_C / 2 - (minY / N) * EARTH_C; // metres north of the equator

  return {
    cell,
    left,
    top,

    toSurface(lon, lat) {
      const xe = ((lon * Math.PI) / 180) * R;
      const yn = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));
      return [xe - left, top - yn];
    },

    toLoc(mx, my) {
      const lon = ((left + mx) / R) * (180 / Math.PI);
      const lat =
        (2 * Math.atan(Math.exp((top - my) / R)) - Math.PI / 2) * (180 / Math.PI);
      return [lon, lat];
    },
  };
}

/** Fill in the `{z}/{x}/{y}` placeholders of a heatmap URL template. */
export function tileUrl(template, x, y) {
  return template
    .replace('{z}', String(TILE_Z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{r}', '');
}

/* ------------------------------------------------------------------ *
 * Fetching: page context first, background proxy as fallback
 * ------------------------------------------------------------------ */

const pendingTiles = new Map();
let tileRequestId = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type !== 'strava-slide-tile-result') return;
    const resolve = pendingTiles.get(event.data.id);
    if (!resolve) return;
    pendingTiles.delete(event.data.id);
    resolve(event.data.result);
  });
}

function requestTileFromBackground(url) {
  return new Promise((resolve) => {
    const id = ++tileRequestId;
    const timer = setTimeout(() => {
      if (pendingTiles.delete(id)) resolve({ ok: false, status: 0 });
    }, TILE_FETCH_TIMEOUT_MS);

    pendingTiles.set(id, (result) => {
      clearTimeout(timer);
      resolve(result || { ok: false, status: 0 });
    });

    window.postMessage({ type: 'strava-slide-tile', id, url }, window.location.origin);
  });
}

function blobToImage(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }
  return dataUrlToImage(URL.createObjectURL(blob));
}

function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(tileError('decode', 'Heatmap tile could not be decoded'));
    image.src = dataUrl;
  });
}

/**
 * Load one tile as a drawable image (ImageBitmap or HTMLImageElement).
 * Throws an error with `code: 'auth'` when Strava rejects the request.
 */
async function fetchTileImage(url) {
  let pageStatus = 0;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TILE_FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      credentials: 'omit',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) return await blobToImage(await response.blob());
    pageStatus = response.status;
  } catch (error) {
    // CORS or page CSP blocked the request; fall through to the proxy.
    pageStatus = 0;
  }

  const proxied = await requestTileFromBackground(url);
  if (proxied.ok) return await dataUrlToImage(proxied.dataUrl);

  const status = proxied.status || pageStatus;
  if (status === 403 || status === 401) {
    throw tileError('auth', 'Strava rejected the heatmap tile request');
  }
  throw tileError('fetch', `Heatmap tile request failed${status ? ` (${status})` : ''}`);
}

/* ------------------------------------------------------------------ *
 * Surface assembly
 * ------------------------------------------------------------------ */

/**
 * Load every tile of `range`, stitch them into one canvas and build the
 * Slide surface.
 *
 * @param {string} template  heatmap URL template from an enabled overlay
 * @param {{minX:number, minY:number, cols:number, rows:number}} range
 * @param {object} params    Slide params, used for the smoothing kernel
 * @returns {Promise<{surface, smooth, georef, cell, mercatorScale}>}
 */
export async function loadSurface(template, range, params) {
  const first = await fetchTileImage(tileUrl(template, range.minX, range.minY));
  const tilePx = first.width;
  if (!tilePx || !first.height) {
    throw tileError('decode', 'Heatmap tile has no pixel size');
  }

  // Down-scale large mosaics so the surface stays within MAX_EDGE_PX.
  const scale = Math.min(
    1,
    MAX_EDGE_PX / Math.max(range.cols * tilePx, range.rows * tilePx)
  );
  const px = Math.max(1, Math.round(tilePx * scale));
  const width = px * range.cols;
  const height = px * range.rows;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(first, 0, 0, px, px);

  const pending = [];
  for (let row = 0; row < range.rows; row++) {
    for (let col = 0; col < range.cols; col++) {
      if (row === 0 && col === 0) continue;
      pending.push(
        fetchTileImage(tileUrl(template, range.minX + col, range.minY + row)).then(
          (image) => ctx.drawImage(image, col * px, row * px, px, px)
        )
      );
    }
  }
  await Promise.all(pending);

  const pixels = ctx.getImageData(0, 0, width, height).data;
  const values = new Float64Array(width * height);
  for (let i = 0, j = 0; i < values.length; i++, j += 4) {
    values[i] = colorValue(pixels[j], pixels[j + 1], pixels[j + 2]);
  }
  canvas.width = canvas.height = 0; // release the backing store

  // `range.cols` tiles span `range.cols * tile ground size` metres.
  const cell = ((EARTH_C / N) * range.cols) / width;
  const georef = makeGeoref(range.minX, range.minY, cell);
  const surface = new Surface(values, width, height, cell);

  const centerLat = georef.toLoc((width * cell) / 2, (height * cell) / 2)[1];
  const mercatorScale = 1 / Math.cos((centerLat * Math.PI) / 180);
  const smooth = new SmoothSurface(
    surface,
    buildKernel(params.smoothingStdDev, cell, mercatorScale)
  );

  return { surface, smooth, georef, cell, mercatorScale, width, height };
}
