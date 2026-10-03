/**
 * Relays heatmap tile requests between the page (slide/tiles.js) and the
 * background service worker, which is not bound by the page's CORS rules or
 * Content-Security-Policy.
 *
 * Runs in the content-script world, so it shares the page's `window` but not
 * its JavaScript objects: everything crosses as `postMessage` payloads.
 */

(async function main() {
  console.debug('[StravaHeatmapExt] executing content/slide-bridge.js');

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    const { type, id, url } = event.data || {};
    if (type !== 'strava-slide-tile') return;

    let result;
    try {
      result = await browser.runtime.sendMessage({
        type: 'fetchHeatmapTile',
        payload: { url },
      });
    } catch (error) {
      console.warn('[StravaHeatmapExt] Tile proxy request failed', error);
      result = { ok: false, status: 0 };
    }

    window.postMessage(
      { type: 'strava-slide-tile-result', id, result },
      window.location.origin
    );
  });
})();
