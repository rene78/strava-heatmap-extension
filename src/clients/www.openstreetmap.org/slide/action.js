/**
 * Slide action — write a slid polyline back onto an iD way.
 *
 * A port of strava/iD's js/id/actions/slide.js
 * (https://github.com/strava/iD) to the current iD APIs. The original was
 * written against iD v2 of 2014; the algorithm is unchanged:
 *
 *  - the first and last node are anchors and never move,
 *  - interior nodes are matched monotonically to the nearest point of the
 *    slid path and moved there,
 *  - slid path points that no node covers become new nodes,
 *  - "interesting" nodes (shared with other ways, in relations, or carrying
 *    tags) are kept and snapped onto the new line instead of being moved
 *    wholesale.
 *
 * One deliberate deviation from the original: it deleted interior nodes that
 * ran out of slid path points. Never mind that this is rare (the caller sizes
 * the slid path to at least the way's own vertex count), silently deleting
 * somebody's nodes is not acceptable in an editor — those nodes fall back to
 * the globally nearest slid point instead.
 *
 * The result is a plain `(graph) => graph` function, so iD records it as a
 * single undoable history entry when applied with `context.perform()`.
 *
 * The slid path (`slidLocs`) is a dense [[lon, lat], ...] polyline whose
 * first and last points are the way's own endpoints — Slide pins them.
 */

const DUPLICATE_RADIUS_M = 5; // strava/iD: replace, don't duplicate, near-coincident nodes

/** Cheap distance² in degrees — only used to rank candidates along one line. */
function distanceSqDeg(a, b) {
  const meanLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (a[0] - b[0]) * Math.cos(meanLat);
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * @param {object} context   iD context (needs `.projection` and `.graph()`)
 * @param {string} wayId     the way being slid
 * @param {Array<[number, number]>} slidLocs  dense [[lon, lat], ...] result
 * @returns {(graph: object) => object} iD action
 */
export function buildSlideAction(context, wayId, slidLocs) {
  const projection = context.projection;

  return function slideAction(graph) {
    const iD = window.iD;
    const way = graph.entity(wayId);
    const nodes = way.nodes.map((id) => graph.entity(id));
    const pointCount = slidLocs.length;

    if (nodes.length < 2 || pointCount < 2) return graph;

    const created = new Set(); // ids of nodes instantiated by this action
    const isInteresting = (node) =>
      !created.has(node.id) &&
      (graph.parentWays(node).length > 1 ||
        graph.parentRelations(node).length > 0 ||
        node.hasInterestingTags());

    const nodeCount = nodes.length;

    // --- match every interior node to a slid point (monotonically) ---
    const matched = new Array(nodeCount);
    matched[0] = 0;
    matched[nodeCount - 1] = pointCount - 1;
    const deferred = []; // interesting nodes, snapped in a second pass
    let previous = 0;

    for (let i = 1; i < nodeCount - 1; i++) {
      const node = nodes[i];
      if (isInteresting(node)) {
        matched[i] = null;
        deferred.push(i);
        continue;
      }

      let best = -1;
      let bestDistance = Infinity;
      for (let j = previous + 1; j < pointCount - 1; j++) {
        const distance = distanceSqDeg(node.loc, slidLocs[j]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = j;
        }
      }

      if (best < 0) {
        // Ran out of slid path going forward (folded geometry): fall back to
        // the globally nearest point rather than deleting the node.
        for (let j = 1; j < pointCount - 1; j++) {
          const distance = distanceSqDeg(node.loc, slidLocs[j]);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = j;
          }
        }
      }
      if (best < 0) {
        matched[i] = -2; // slid path is degenerate: leave the node alone
        continue;
      }

      previous = Math.max(previous, best);
      matched[i] = best;
    }

    // --- build the new node list ---
    const out = [nodes[0]];
    previous = 0;
    for (let i = 1; i < nodeCount; i++) {
      const index = matched[i];
      if (index === null) continue; // interesting: placed in the second pass

      if (index >= 0) {
        for (let j = previous + 1; j < index; j++) {
          // iD 2.43 made osmNode an ES class, so it must be constructed;
          // the old function-style factory accepted `new` as well.
          const node = new iD.osmNode({ loc: slidLocs[j] });
          created.add(node.id);
          out.push(node);
        }
        previous = Math.max(previous, index);
      }

      // the last node sits on the path's final point, which is its own loc
      out.push(
        i === nodeCount - 1 || index < 0 ? nodes[i] : nodes[i].move(slidLocs[index])
      );
    }

    // --- snap the interesting nodes onto the new line ---
    for (const i of deferred) {
      const node = nodes[i];
      const choice = iD.geoChooseEdge(out, projection(node.loc), projection);
      if (!choice) {
        out.push(node); // degenerate line: keep it as drawn
        continue;
      }

      const moved = node.move(choice.loc);
      // never swap out an endpoint: Slide pins them
      const replaceable = (index) =>
        index > 0 && index < out.length - 1 && !isInteresting(out[index]);
      const before = choice.index - 1;
      const after = choice.index;

      if (
        replaceable(before) &&
        iD.geoSphericalDistance(out[before].loc, choice.loc) < DUPLICATE_RADIUS_M
      ) {
        out[before] = moved;
      } else if (
        replaceable(after) &&
        iD.geoSphericalDistance(out[after].loc, choice.loc) < DUPLICATE_RADIUS_M
      ) {
        out[after] = moved;
      } else {
        out.splice(choice.index, 0, moved);
      }
    }

    // --- apply: replace/add what survives, drop what doesn't, update the way
    const survivingIds = new Set(out.map((node) => node.id));
    let next = graph;
    for (const node of out) next = next.replace(node);
    next = next.replace(way.update({ nodes: out.map((node) => node.id) }));
    for (const node of nodes) {
      if (!survivingIds.has(node.id)) next = next.remove(node);
    }
    return next;
  };
}
