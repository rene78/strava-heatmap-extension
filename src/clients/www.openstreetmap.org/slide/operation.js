/**
 * The "Slide to Heatmap" iD operation.
 *
 * Builds the operation object that `modules/ui/edit_menu.js` renders into the
 * editor's right-click menu, and runs the Slide pipeline when it is invoked:
 *
 *     selected way -> heatmap tiles -> Surface -> session -> slid path
 *                  -> buildSlideAction() -> context.perform()
 *
 * Auth is checked here: the operation reports itself unavailable unless the
 * extension is signed in to Strava, so the menu item never shows up while
 * signed out (see the `authenticated` flag that inject-client.js hands to the
 * client script and that watch-storage.js keeps up to date).
 */

import { DEFAULTS, createSession, finalize } from './slide.js';
import { enabledHeatmapTemplate, loadSurface, tileRange } from './tiles.js';
import { buildSlideAction } from './action.js';

const SLIDE_SHORTCUT = '⇧S';
const SLIDE_ICON_ID = 'strava-slide-operation';

/** Metres between adjacent vertices of the slid path handed to the action. */
function resampleIntervalFor({ cell, totalLength, nodeCount, mercatorScale }) {
  // jsSlide tuned 5 m on a 2.39 m/px tile (~2 px); keep that bead spacing
  // whatever resolution the server ends up sending us.
  const desired = Math.max(DEFAULTS.resampleInterval, 2 * cell);

  // The action maps every way node onto its own slid point, so the path must
  // never come out sparser than the way itself — otherwise matching would have
  // nowhere to put the surplus nodes. `preparePath` resamples at
  // `interval * mercatorScale`, hence the division here.
  if (totalLength > 0 && nodeCount > 0) {
    const denseEnough = totalLength / (nodeCount * mercatorScale);
    return Math.max(0.5, Math.min(desired, denseEnough));
  }
  return desired;
}

/** Length of the way in metres. */
function pathLength(locs) {
  const iD = window.iD;
  let total = 0;
  for (let i = 1; i < locs.length; i++) {
    total += iD.geoSphericalDistance(locs[i - 1], locs[i]);
  }
  return total;
}

function selectedWay(context) {
  if (!context.mode || context.mode().id !== 'select') return null;
  const ids = context.selectedIDs ? context.selectedIDs() : [];
  if (ids.length !== 1) return null;
  const entity = context.hasEntity(ids[0]);
  if (!entity || entity.type !== 'way') return null;
  if (entity.geometry(context.graph()) !== 'line') return null;
  return entity;
}

function wayLocs(context, way) {
  const locs = [];
  for (const id of way.nodes) {
    const node = context.hasEntity(id);
    if (!node) return null;
    locs.push(node.loc);
  }
  return locs.length >= 2 ? locs : null;
}

function flash(context, message, isError) {
  try {
    context
      .ui()
      .flash.duration(5000)
      .iconName(isError ? '#iD-icon-no' : '#iD-operation-slide')
      .iconClass(isError ? 'operation disabled' : 'operation')
      .label(message)();
  } catch (error) {
    console.warn('[StravaHeatmapExt] flash failed', error);
  }
}

/**
 * iD renders `svgIcon(op.icon() || '#iD-operation-' + op.id)` — there is no
 * `#iD-operation-slide` sprite symbol, so we ship our own. It has to be
 * (re)injected lazily because `context.ui().restart()` — which the extension
 * triggers whenever imagery changes — wipes the defs container.
 */
function ensureIconSymbol() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SLIDE_ICON_ID)) return;
  const defs = document.getElementById('ideditor-defs');
  if (!defs) return;

  const svgNs = 'http://www.w3.org/2000/svg';
  const symbol = document.createElementNS(svgNs, 'symbol');
  symbol.id = SLIDE_ICON_ID;
  symbol.setAttribute('viewBox', '0 0 20 20');

  // A winding trail rendered as a filled ribbon (iD's menu styles `use { fill }`).
  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute(
    'd',
    'M2 16 L2 13 C5 13 6 5 10 5 C14 5 15 13 18 13 L18 16 ' +
      'C15 16 14 8 10 8 C6 8 5 16 2 16 Z'
  );
  symbol.appendChild(path);
  defs.appendChild(symbol);
}

/** Run `session.step()` in ~12 ms slices so iD stays responsive. */
function runSession(session) {
  return new Promise((resolve) => {
    const tick = () => {
      const started = performance.now();
      while (!session.done && performance.now() - started < 12) session.step();
      if (session.done) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function explain(error) {
  switch (error && error.code) {
    case 'auth':
      return 'Strava session expired — click the extension icon to sign in.';
    case 'no_overlay':
      return 'Enable a Strava Heatmap overlay first (Background panel → Overlays).';
    case 'too_large':
      return 'This line covers too much heatmap area — slide a shorter section.';
    case 'noop':
      return 'This line is too short to slide.';
    case 'no_way':
      return 'Select a line first.';
    default:
      return `Slide failed${error && error.message ? `: ${error.message}` : ''}`;
  }
}

/**
 * @param {object} context     iD context
 * @param {() => {authenticated: boolean}} getState  live extension state
 * @param {{running: boolean}} runtime      shared re-entrancy flag
 */
export function makeSlideOperation(context, getState, runtime) {
  const operation = () => {
    void run();
  };

  operation.id = 'slide';
  operation.title = 'Slide to Heatmap';
  operation.keys = [SLIDE_SHORTCUT];
  operation.icon = () => {
    ensureIconSymbol();
    return `#${SLIDE_ICON_ID}`;
  };
  operation.annotation = () => 'Slid line to Strava heatmap';

  operation.available = () =>
    Boolean(getState().authenticated) && Boolean(selectedWay(context));

  operation.disabled = () => {
    if (runtime.running) return 'running';
    if (!enabledHeatmapTemplate(context)) return 'no_overlay';
    const way = selectedWay(context);
    if (!way) return 'no_way';
    if (!wayLocs(context, way)) return 'no_way';
    if (!tileRange(wayLocs(context, way))) return 'too_long';
    return false;
  };

  operation.tooltip = () => {
    const reason = operation.disabled();
    if (reason === 'no_overlay') {
      return 'Enable a Strava Heatmap overlay first (Background panel → Overlays).';
    }
    if (reason === 'too_long') {
      return 'This line is too long to slide in one go — split it first.';
    }
    if (reason === 'running') return 'A slide is already running.';
    if (reason === 'no_way') return 'Select a line first.';
    return 'Snap this line to the nearest trace in the Strava Heatmap.';
  };

  async function run() {
    if (runtime.running) return;

    // the menu item is only rendered while signed in, but the shortcut and a
    // session that expired mid-edit can both get here without credentials
    if (!getState().authenticated) {
      flash(context, explain({ code: 'auth' }), true);
      return;
    }

    const reason = operation.disabled();
    if (reason) {
      flash(context, operation.tooltip(), true);
      return;
    }

    const way = selectedWay(context);
    const locs = wayLocs(context, way);
    const template = enabledHeatmapTemplate(context);
    const range = tileRange(locs);
    if (!way || !locs || !template || !range) return;

    runtime.running = true;
    const loading = window.iD
      .uiLoading(context)
      .blocking(true)
      .message('Sliding to heatmap…');
    context.container().call(loading);

    try {
      const params = { ...DEFAULTS, ghostCount: 0 };
      const { surface, smooth, georef, cell, mercatorScale } = await loadSurface(
        template,
        range,
        params
      );
      params.mercatorScale = mercatorScale;
      params.resampleInterval = resampleIntervalFor({
        cell,
        totalLength: pathLength(locs),
        nodeCount: locs.length,
        mercatorScale,
      });

      // way coordinates -> surface metres
      const points = new Float64Array(locs.length * 2);
      for (let i = 0; i < locs.length; i++) {
        const [mx, my] = georef.toSurface(locs[i][0], locs[i][1]);
        points[2 * i] = mx;
        points[2 * i + 1] = my;
      }

      const session = createSession(surface, smooth, points, params);
      await runSession(session);
      let slid = finalize(session);
      if (slid.length / 2 < locs.length) {
        // Douglas-Peucker simplified the result below the way's own vertex
        // count — fall back to the unsimplified path so every node can claim
        // a slid point.
        slid = session.path;
      }
      if (slid.length / 2 < 3 && locs.length > 2) {
        throw { code: 'noop', message: 'result too short' };
      }

      // surface metres -> way coordinates, endpoints pinned to the originals
      const slidLocs = [];
      for (let i = 0; i < slid.length; i += 2) {
        slidLocs.push(georef.toLoc(slid[i], slid[i + 1]));
      }
      slidLocs[0] = locs[0].slice();
      slidLocs[slidLocs.length - 1] = locs[locs.length - 1].slice();

      // the map is blocked while loading, but the user may still have undone
      // or switched selection through a shortcut
      const current = context.hasEntity(way.id);
      if (!current || current.type !== 'way') return;

      context.perform(
        buildSlideAction(context, way.id, slidLocs),
        operation.annotation()
      );
      if (context.validator) context.validator().validate();
      console.debug(
        '[StravaHeatmapExt] Slid %s: %d nodes -> %d points, %d iterations',
        way.id,
        way.nodes.length,
        slidLocs.length,
        session.iterations
      );
    } catch (error) {
      console.error('[StravaHeatmapExt] Slide failed', error);
      flash(context, explain(error), true);
    } finally {
      loading.close();
      runtime.running = false;
    }
  }

  return operation;
}
