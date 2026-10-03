/**
 * Proxy for Strava heatmap tile requests made by the page.
 *
 * The page-context `fetch()` in slide/tiles.js normally succeeds on its own —
 * the extension's declarativeNetRequest rule injects the Strava cookies and an
 * `Access-Control-Allow-Origin: *` header (see background/rules.js). When that
 * path is blocked (CORS, or osm.org's Content-Security-Policy `connect-src`),
 * the page asks the content script to relay the request through here instead:
 * a service worker fetch is subject to neither, and `host_permissions` for
 * `content-a.strava.com` keep it same-origin-ish for the purposes of cookies.
 *
 * Responds with a data URL rather than raw bytes so the payload survives
 * JSON-serialised `runtime.sendMessage` on every browser.
 */

const HEATMAP_URL_RE = /^https:\/\/[^/]+\.strava\.com\/identified\/globalheat\//;
const MAX_TILE_BYTES = 16 * 1024 * 1024;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000; // avoid blowing the argument stack
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * @param {{url: string}} payload
 * @returns {Promise<{ok: true, dataUrl: string} | {ok: false, status: number}>}
 */
export async function fetchHeatmapTile({ url } = {}) {
  if (typeof url !== 'string' || !HEATMAP_URL_RE.test(url)) {
    return { ok: false, status: 0 };
  }

  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return { ok: false, status: response.status };

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_TILE_BYTES) {
      return { ok: false, status: 0 };
    }

    const type = response.headers.get('content-type') || 'image/png';
    return { ok: true, dataUrl: `data:${type};base64,${toBase64(buffer)}` };
  } catch (error) {
    console.warn('[StravaHeatmapExt] Tile proxy failed', error);
    return { ok: false, status: 0 };
  }
}
