/**
 * Tests for the "Slide to Heatmap" feature.
 *
 *   node test/slide.test.mjs   (or: npm test)
 *
 * Covers the three pieces that are ours, as opposed to the vendored jsSlide
 * engine (whose own suite lives in the jsSlide repo):
 *
 *   1. tile math / georeferencing  (slide/tiles.js)
 *   2. the Slide engine smoke test on a synthetic heatmap (slide/slide.js)
 *   3. writing a slid path back onto a way (slide/action.js)
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const R = 6378137;
const EARTH_C = 2 * Math.PI * R;
const N = 2 ** 14; // z14

const slideDir = fileURLToPath(
  new URL('../src/clients/www.openstreetmap.org/slide/', import.meta.url)
);

const tiles = await import(`${slideDir}tiles.js`);
const action = await import(`${slideDir}action.js`);
const slide = await import(`${slideDir}slide.js`);
const surfaceModule = await import(`${slideDir}surface.js`);

// imported for their side effect of existing: these only ever run in a
// browser, so just proving they parse and resolve their imports is the test
await import(`${slideDir}operation.js`);
await import(`${slideDir}install.js`);
await import(new URL('../src/background/tiles.js', import.meta.url).href);

const { Surface, SmoothSurface, buildKernel } = surfaceModule;
const { makeGeoref, tileRange, tileUrl, lonToTileX, latToTileY, enabledHeatmapTemplate } =
  tiles;
const { buildSlideAction } = action;
const { DEFAULTS, createSession, finalize } = slide;

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function near(actual, expected, tolerance, what) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} ±${tolerance}, got ${actual}`
  );
}

/* ------------------------------------------------------------------ *
 * 1. tile math / georeferencing
 * ------------------------------------------------------------------ */

console.log('tiles.js');

// jsSlide's reference tile: README documents it as lon 101.513672..101.535645
const TILE_X = 12812;
const TILE_Y = 8038;
const TILE_PX = 1024;
const cell = EARTH_C / N / TILE_PX;
const georef = makeGeoref(TILE_X, TILE_Y, cell);

await test('cell size matches jsSlide (EARTH_C / (2^14 * 1024))', () => {
  near(cell, 2.3887, 0.001, 'cell');
});

await test('tile x -> longitude matches the Web Mercator grid', () => {
  const [lon] = georef.toLoc(0, 0);
  near(lon, (TILE_X / N - 0.5) * 360, 1e-9, 'left longitude');
  near(lon, 101.513672, 1e-5, 'jsSlide README left longitude');
});

await test('tile y -> latitude matches the Web Mercator tile grid', () => {
  // independent formulation of "latitude at the top edge of tile y"
  const standard =
    Math.atan(Math.sinh(Math.PI * (1 - (2 * TILE_Y) / N))) * (180 / Math.PI);
  const [, lat] = georef.toLoc(0, 0);
  near(lat, standard, 1e-9, 'top latitude');
});

await test('canvas span covers exactly one tile', () => {
  const [lonRight, latBottom] = georef.toLoc(TILE_PX * cell, TILE_PX * cell);
  const [lonLeft, latTop] = georef.toLoc(0, 0);
  near(lonRight - lonLeft, 360 / N, 1e-9, 'longitude span');
  near(lonRight, 101.535645, 1e-5, 'jsSlide README right longitude');
  assert.ok(latBottom < latTop, 'y grows downwards');
});

await test('toSurface / toLoc round-trip', () => {
  const [lon, lat] = [101.52, 3.37];
  const [mx, my] = georef.toSurface(lon, lat);
  const [lon2, lat2] = georef.toLoc(mx, my);
  near(lon2, lon, 1e-9, 'longitude');
  near(lat2, lat, 1e-9, 'latitude');
});

await test('toSurface is 0,0 at the canvas origin', () => {
  const [mx, my] = georef.toSurface(101.513671875, georef.toLoc(0, 0)[1]);
  near(mx, 0, 1e-6, 'mx');
  near(my, 0, 1e-6, 'my');
});

await test('lonToTileX / latToTileY round-trip on tile corners', () => {
  const [lon, lat] = georef.toLoc(0, 0);
  assert.equal(lonToTileX(lon), TILE_X);
  assert.equal(latToTileY(lat), TILE_Y);
  const [lonBottom, latBottom] = georef.toLoc(TILE_PX * cell, TILE_PX * cell);
  assert.equal(lonToTileX(lonBottom - 1e-9), TILE_X);
  assert.equal(latToTileY(latBottom + 1e-9), TILE_Y);
});

await test('tileRange covers a line inside one tile', () => {
  const range = tileRange([
    [101.52, 3.37],
    [101.521, 3.371],
  ]);
  assert.deepEqual(range, { minX: TILE_X, minY: TILE_Y, cols: 1, rows: 1 });
});

await test('tileRange refuses lines crossing more than 3 tiles', () => {
  // ~4 tiles east-west at z14 (a tile is ~2.4 km)
  const west = georef.toLoc(0, 0)[0];
  assert.equal(
    tileRange([
      [west, 3.37],
      [west + (360 / N) * 3.5, 3.37],
    ]),
    null
  );
});

await test('tileRange refuses lines crossing the antimeridian', () => {
  assert.equal(
    tileRange([
      [179.9, 0],
      [-179.9, 0],
    ]),
    null
  );
});

await test('tileUrl fills the z/x/y placeholders', () => {
  assert.equal(
    tileUrl('https://x.example/globalheat/all/hot/{z}/{x}/{y}.png?v=19', 1, 2),
    'https://x.example/globalheat/all/hot/14/1/2.png?v=19'
  );
});

await test('enabledHeatmapTemplate picks the enabled Strava overlay', () => {
  const makeContext = (sources) => ({
    background: () => ({ overlayLayerSources: () => sources }),
  });
  const template =
    'https://content-a.strava.com/identified/globalheat/run/hot/{z}/{x}/{y}.png?v=19';

  // iD's rendererBackgroundSource() exposes `template` as an accessor
  // function: source.template() returns the raw URL string.
  const iDSource = (id, url) => ({ id, template: () => url });

  assert.equal(
    enabledHeatmapTemplate(
      makeContext([
        iDSource('bing', 'https://bing.example/{z}/{x}/{y}.jpg'),
        iDSource('strava-heatmap-run', template),
      ])
    ),
    template,
    'reads the accessor function iD sources use'
  );
  assert.equal(
    enabledHeatmapTemplate(
      makeContext([iDSource('strava-heatmap-run', 'https://example.com/tiles')])
    ),
    null,
    'rejects a Strava overlay without a heatmap URL'
  );
  assert.equal(
    enabledHeatmapTemplate(
      makeContext([iDSource('bing', 'https://bing.example/{z}/{x}/{y}.jpg')])
    ),
    null,
    'ignores non-Strava overlays'
  );
  assert.equal(
    enabledHeatmapTemplate(makeContext([{ id: 'strava-heatmap-run', template }])),
    template,
    'still accepts a plain string template'
  );
});

/* ------------------------------------------------------------------ *
 * 2. the engine on a synthetic heatmap
 * ------------------------------------------------------------------ */

console.log('slide.js (vendored engine)');

await test('the slid path climbs onto the trail and keeps its endpoints', () => {
  const w = 240;
  const h = 240;
  const mCell = 2.4;
  const values = new Float64Array(w * h);

  // a sinuous trail: value 5 on the centre line, falling off sideways
  const trailY = (x) => h * 0.4 + 45 * Math.sin(x / 45);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = y - trailY(x);
      values[y * w + x] = 5 * Math.exp(-(d * d) / (2 * 9 * 9));
    }
  }

  const unsmoothed = new Surface(values, w, h, mCell);
  const smooth = new SmoothSurface(unsmoothed, buildKernel(16, mCell, 1));

  // a straight line that crosses the trail region diagonally
  // (surface coordinates are metres from the top-left corner)
  const points = new Float64Array(2 * 21);
  for (let i = 0; i <= 20; i++) {
    points[2 * i] = (30 + i * 8) * mCell;
    points[2 * i + 1] = 150 * mCell;
  }

  const params = { ...DEFAULTS, ghostCount: 0, mercatorScale: 1 };
  const session = createSession(unsmoothed, smooth, points, params);
  const startScore = unsmoothed.valueAt(points[2], points[3]);

  let guard = 0;
  while (!session.done && guard++ < 5000) session.step();

  assert.ok(session.done, 'session converged');
  assert.ok(
    session.score > startScore,
    `score should improve (${startScore.toFixed(3)} -> ${session.score.toFixed(3)})`
  );
  assert.equal(session.path[0], points[0], 'first endpoint pinned');
  assert.equal(session.path[1], points[1], 'first endpoint pinned');
  assert.equal(
    session.path[session.path.length - 2],
    points[points.length - 2],
    'last endpoint pinned'
  );

  // and the reduced output is still a usable path
  const reduced = finalize(session);
  assert.ok(reduced.length >= 4, 'finalize keeps at least 2 points');
});

/* ------------------------------------------------------------------ *
 * 3. the action: slid path -> way
 * ------------------------------------------------------------------ */

console.log('action.js');

const DEG = 0.00001; // ~1 m

// --- minimal stand-ins for the bits of iD the action touches -------------
let nextId = 0;

function makeNode(loc, tags = {}) {
  return {
    type: 'node',
    id: `n-${--nextId}`,
    loc: loc.slice(),
    tags,
    move(newLoc) {
      return { ...this, loc: newLoc.slice() };
    },
    hasInterestingTags() {
      return Object.keys(this.tags).length > 0;
    },
  };
}

function makeWay(id, nodeIds) {
  return {
    type: 'way',
    id,
    nodes: nodeIds.slice(),
    tags: { highway: 'path' },
    update(props) {
      return { ...this, ...props };
    },
  };
}

function makeGraph(entities) {
  return fromEntries(new Map(entities.map((entity) => [entity.id, entity])));
}

function replaceIn(graph, entity) {
  const entries = new Map();
  for (const [id, value] of graph.entries) entries.set(id, value);
  entries.set(entity.id, entity);
  return fromEntries(entries);
}

function removeFrom(graph, entity) {
  const entries = new Map(graph.entries);
  entries.delete(entity.id);
  return fromEntries(entries);
}

function fromEntries(entries) {
  const graph = {
    entries,
    entity(id) {
      return entries.get(id);
    },
    replace(entity) {
      return replaceIn(graph, entity);
    },
    remove(entity) {
      return removeFrom(graph, entity);
    },
    parentWays(node) {
      return [...entries.values()].filter(
        (e) => e.type === 'way' && e.nodes.includes(node.id)
      );
    },
    parentRelations() {
      return [];
    },
  };
  return graph;
}

// iD-like projection for the test area (degrees -> arbitrary plane)
function projection(loc) {
  return [loc[0] * 100000, loc[1] * 100000];
}
projection.invert = (p) => [p[0] / 100000, p[1] / 100000];

function sphericalDistance(a, b) {
  const meanLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (a[0] - b[0]) * Math.cos(meanLat) * 111320;
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

// copy of iD.geo.geom's geoChooseEdge, against the test projection
function geoChooseEdge(nodes, point) {
  let min = Infinity;
  let result = null;
  for (let i = 0; i < nodes.length - 1; i++) {
    const o = projection(nodes[i].loc);
    const s = [
      projection(nodes[i + 1].loc)[0] - o[0],
      projection(nodes[i + 1].loc)[1] - o[1],
    ];
    const v = [point[0] - o[0], point[1] - o[1]];
    const dot = s[0] * s[0] + s[1] * s[1];
    const t = dot === 0 ? 0 : (v[0] * s[0] + v[1] * s[1]) / dot;
    const clamped = Math.max(0, Math.min(1, t));
    const p = [o[0] + clamped * s[0], o[1] + clamped * s[1]];
    const d = Math.hypot(p[0] - point[0], p[1] - point[1]);
    if (d < min) {
      min = d;
      result = { index: i + 1, distance: d, loc: projection.invert(p) };
    }
  }
  return result;
}

globalThis.window = {
  iD: {
    // iD 2.43 made osmNode an ES class: calling it as a plain function throws
    // "Class constructor ... cannot be invoked without 'new'", so the mock has
    // to behave the same way or this regression stays invisible in tests.
    osmNode: class osmNode {
      constructor({ loc, tags } = {}) {
        return makeNode(loc, tags);
      }
    },
    geoSphericalDistance: sphericalDistance,
    geoChooseEdge,
  },
};

const context = { projection };

function slidLine(from, to, count) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  return points;
}

await test('interior nodes move onto the slid path, endpoints stay put', () => {
  const start = [101.514, 3.37];
  const end = [101.534, 3.37];
  const nodes = [
    makeNode(start),
    makeNode([101.52, 3.3708]),
    makeNode([101.526, 3.3709]),
    makeNode(end),
  ];
  const way = makeWay(
    'w1',
    nodes.map((n) => n.id)
  );
  const graph = makeGraph([way, ...nodes]);

  // the slid path runs along a slightly different latitude
  const slidLocs = slidLine([start[0], 3.3695], [end[0], 3.3695], 13);

  const next = buildSlideAction(context, 'w1', slidLocs)(graph);
  const slidWay = next.entity('w1');

  assert.equal(slidWay.nodes[0], nodes[0].id, 'first node unchanged');
  assert.equal(
    slidWay.nodes[slidWay.nodes.length - 1],
    nodes[3].id,
    'last node unchanged'
  );
  assert.deepEqual(next.entity(nodes[0].id).loc, start, 'first node location pinned');
  assert.deepEqual(next.entity(nodes[3].id).loc, end, 'last node location pinned');

  for (const id of [nodes[1].id, nodes[2].id]) {
    const node = next.entity(id);
    assert.ok(node, `${id} still exists`);
    near(node.loc[1], 3.3695, 1e-6, `${id} snapped to the slid latitude`);
  }

  // the slid path is denser than the way, so it contributes new vertices
  assert.ok(slidWay.nodes.length > 4, `new vertices added (${slidWay.nodes.length})`);
  assert.equal(new Set(slidWay.nodes).size, slidWay.nodes.length, 'no duplicate ids');

  for (const id of slidWay.nodes) {
    assert.ok(next.entity(id), `way references existing node ${id}`);
  }
});

await test('a node shared with another way is kept and snapped', () => {
  const start = [101.514, 3.37];
  const end = [101.534, 3.37];
  const a = makeNode(start);
  const shared = makeNode([101.52, 3.3708]);
  const b = makeNode(end);
  const other = makeNode([101.52, 3.38]);
  const way = makeWay('w1', [a.id, shared.id, b.id]);
  const crossing = makeWay('w2', [other.id, shared.id]);
  const graph = makeGraph([way, crossing, a, shared, b, other]);

  const slidLocs = slidLine([start[0], 3.3695], [end[0], 3.3695], 13);
  const next = buildSlideAction(context, 'w1', slidLocs)(graph);
  const slidWay = next.entity('w1');

  assert.ok(slidWay.nodes.includes(shared.id), 'shared node survives');
  assert.ok(next.entity(shared.id), 'shared node still in the graph');
  near(next.entity(shared.id).loc[1], 3.3695, 1e-5, 'shared node snapped to the line');
  assert.ok(
    Math.abs(next.entity(shared.id).loc[0] - 101.52) < 1e-4,
    'shared node stays near its own longitude'
  );
  assert.equal(next.entity(crossing.id).nodes.length, 2, 'crossing way untouched');
  assert.equal(next.entity(a.id).loc[1], start[1], 'start still pinned');
  assert.equal(next.entity(b.id).loc[1], end[1], 'end still pinned');
});

await test('never deletes nodes when the slid path is sparser than the way', () => {
  const start = [101.514, 3.37];
  const end = [101.534, 3.37];
  const nodes = [start];
  for (let i = 1; i < 9; i++) {
    const t = i / 9;
    nodes.push([start[0] + (end[0] - start[0]) * t, 3.3708]);
  }
  nodes.push(end);

  const nodeEntities = nodes.map((loc) => makeNode(loc));
  const way = makeWay(
    'w1',
    nodeEntities.map((n) => n.id)
  );
  const graph = makeGraph([way, ...nodeEntities]);

  const slidLocs = slidLine([start[0], 3.3695], [end[0], 3.3695], 4);

  const next = buildSlideAction(context, 'w1', slidLocs)(graph);
  const slidWay = next.entity('w1');

  assert.equal(
    slidWay.nodes.length,
    nodeEntities.length,
    'every original node is still on the way'
  );
  for (const node of nodeEntities) {
    assert.ok(next.entity(node.id), `${node.id} not deleted from the graph`);
  }
});

await test('untouched nodes are not rewritten into the graph', () => {
  const start = [101.514, 3.37];
  const end = [101.534, 3.37];
  const nodes = [makeNode(start), makeNode(end)];
  const way = makeWay(
    'w1',
    nodes.map((n) => n.id)
  );
  const graph = makeGraph([way, ...nodes]);

  // identical path: nothing should change
  const slidLocs = [start, end];
  const next = buildSlideAction(context, 'w1', slidLocs)(graph);

  assert.deepEqual(
    next.entity('w1').nodes,
    nodes.map((n) => n.id),
    'node list unchanged'
  );
  assert.deepEqual(next.entity(nodes[0].id).loc, start, 'start unchanged');
  assert.deepEqual(next.entity(nodes[1].id).loc, end, 'end unchanged');
});

/* ------------------------------------------------------------------ *
 * 4. the operation: availability, gating, tooltip
 * ------------------------------------------------------------------ */

console.log('operation.js');

const { makeSlideOperation } = await import(`${slideDir}operation.js`);

function makeContext({ ids = ['w1'], geometry = 'line', overlay = true } = {}) {
  const way = {
    type: 'way',
    id: 'w1',
    nodes: ['n-1', 'n-2', 'n-3'],
    geometry: () => geometry,
  };
  const nodes = [
    { type: 'node', id: 'n-1', loc: [101.52, 3.37] },
    { type: 'node', id: 'n-2', loc: [101.521, 3.371] },
    { type: 'node', id: 'n-3', loc: [101.522, 3.372] },
  ];
  const entities = new Map([[way.id, way], ...nodes.map((n) => [n.id, n])]);

  return {
    mode: () => ({ id: 'select' }),
    selectedIDs: () => ids,
    graph: () => ({}),
    hasEntity: (id) => entities.get(id),
    background: () => ({
      // iD sources expose `template` as an accessor function, not a string
      overlayLayerSources: () =>
        overlay
          ? [
              {
                id: 'strava-heatmap-all',
                template: () =>
                  'https://content-a.strava.com/identified/globalheat/all/hot/{z}/{x}/{y}.png?v=19',
              },
            ]
          : [],
    }),
  };
}

const runtime = { running: false };

await test('the operation is unavailable while signed out', () => {
  const operation = makeSlideOperation(
    makeContext(),
    () => ({ authenticated: false }),
    runtime
  );
  assert.equal(operation.available(), false, 'hidden while signed out');
});

await test('the operation is available when signed in with a line selected', () => {
  const operation = makeSlideOperation(
    makeContext(),
    () => ({ authenticated: true }),
    runtime
  );
  assert.equal(operation.available(), true);
  assert.equal(operation.disabled(), false);
  assert.equal(
    operation.tooltip(),
    'Snap this line to the nearest trace in the Strava Heatmap.'
  );
  assert.equal(operation.title, 'Slide to Heatmap');
  assert.deepEqual(operation.keys, ['⇧S']);
  assert.equal(operation.icon(), '#strava-slide-operation');
  assert.equal(operation.annotation(), 'Slid line to Strava heatmap');
});

await test('the operation is hidden unless a single line is selected', () => {
  const get = () => ({ authenticated: true });
  assert.equal(
    makeSlideOperation(makeContext({ ids: [] }), get, runtime).available(),
    false,
    'nothing selected'
  );
  assert.equal(
    makeSlideOperation(makeContext({ ids: ['w1', 'w2'] }), get, runtime).available(),
    false,
    'multiple features selected'
  );
  assert.equal(
    makeSlideOperation(makeContext({ geometry: 'area' }), get, runtime).available(),
    false,
    'areas are excluded'
  );
});

await test('the operation explains itself when no overlay is enabled', () => {
  const operation = makeSlideOperation(
    makeContext({ overlay: false }),
    () => ({ authenticated: true }),
    runtime
  );
  assert.equal(operation.available(), true, 'still shown, just greyed out');
  assert.equal(operation.disabled(), 'no_overlay');
  assert.match(operation.tooltip(), /Enable a Strava Heatmap overlay/);
});

await test('a running slide disables the operation', () => {
  const busy = { running: true };
  const operation = makeSlideOperation(
    makeContext(),
    () => ({ authenticated: true }),
    busy
  );
  assert.equal(operation.disabled(), 'running');
});

/* ------------------------------------------------------------------ *
 * 5. the install: menu wrapping and idempotency
 * ------------------------------------------------------------------ */

console.log('install.js');

const { setupSlideOperation } = await import(`${slideDir}install.js`);

function makeUiContext(getState) {
  const shown = [];
  const keybindings = [];
  const ui = {
    showEditMenu(anchor, trigger, operations) {
      shown.push(operations);
      return 'menu';
    },
  };
  const context = Object.assign(makeContext(), {
    ui: () => ui,
    keybinding: () => ({
      on(code, callback) {
        keybindings.push({ code, callback });
      },
    }),
  });
  return { context, ui, shown, keybindings };
}

await test('the menu wrapper appends the operation exactly once', () => {
  const { context, ui, shown } = makeUiContext(() => ({ authenticated: true }));

  setupSlideOperation(context, () => ({ authenticated: true }));
  setupSlideOperation(context, () => ({ authenticated: true }));
  setupSlideOperation(context, () => ({ authenticated: true }));

  assert.equal(ui.showEditMenu(null, 'mouse', undefined), 'menu', 'original still runs');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].length, 1, 'one operation appended (no double wrapping)');
  assert.equal(shown[0][0].id, 'slide');
  assert.equal(typeof shown[0][0], 'function');
});

await test('the menu stays untouched while signed out', () => {
  const { context, ui, shown } = makeUiContext();
  setupSlideOperation(context, () => ({ authenticated: false }));
  ui.showEditMenu(null, 'mouse', undefined);
  assert.equal(shown[0], undefined, 'no operations -> menu not shown');
});

await test('the shortcut is bound to Shift+S', () => {
  const { context, keybindings } = makeUiContext();
  setupSlideOperation(context, () => ({ authenticated: true }));
  assert.deepEqual(
    keybindings.map((binding) => binding.code),
    ['⇧S']
  );
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
