/**
 * Hook the Slide operation into iD's editor menu.
 *
 * iD's operation registry (`modules/id.ts`) exports a frozen module namespace
 * and the operations rendered by `ui/edit_menu.js` come from the active
 * mode — neither can be extended from the outside. `context.ui().showEditMenu`
 * however is an ordinary property on the (cached) ui object, so we wrap it
 * and append our operation to the list whenever a line is selected.
 *
 * The wrapper is installed once and re-used: `context.ui()` returns the same
 * `uiInit` instance for the lifetime of the editor, and `ui.restart()` — which
 * the extension triggers whenever imagery changes — only clears the container
 * and the keybindings. The keybinding is therefore re-registered by every
 * `setupSlideOperation()` call, mirroring `bindOverlaysShortcuts()`.
 */

import { makeSlideOperation } from './operation.js';

const SLIDE_SHORTCUT = '⇧S';

/** Shared across every menu build so a slide can't be started twice. */
const runtime = { running: false };

function bindShortcut(context, getState) {
  context.keybinding().on(SLIDE_SHORTCUT, (d3_event) => {
    const operation = makeSlideOperation(context, getState, runtime);
    if (!operation.available()) return;
    d3_event.preventDefault();
    d3_event.stopImmediatePropagation(); // ⇧S outranks iD's plain `s`
    // blocked states (no overlay, line too long, ...) report themselves
    // with a flash message from run()
    operation();
  });
}

/**
 * Install (once) the edit-menu hook and (re)bind the shortcut.
 *
 * @param {object} context    iD context
 * @param {() => {authenticated: boolean}} getState  live extension state
 */
export function setupSlideOperation(context, getState) {
  const ui = context.ui();

  if (!ui.__stravaSlideWrapped) {
    const showEditMenu = ui.showEditMenu;
    if (typeof showEditMenu !== 'function') {
      // iD changed underneath us: keep the shortcut, drop the menu item
      if (!ui.__stravaSlideMissing) {
        ui.__stravaSlideMissing = true;
        console.warn(
          '[StravaHeatmapExt] iD no longer exposes ui.showEditMenu — Slide to Heatmap menu item disabled'
        );
      }
    } else {
      ui.__stravaSlideWrapped = true;

      ui.showEditMenu = function (anchorPoint, triggerType, operations) {
        let list = operations;
        try {
          const mode = context.mode();
          if ((!list || !list.length) && mode && mode.operations) {
            list = mode.operations();
          }
          const operation = makeSlideOperation(context, getState, runtime);
          if (operation.available()) {
            list = (list || []).concat([operation]);
          }
        } catch (error) {
          console.warn('[StravaHeatmapExt] Could not add Slide menu item', error);
        }
        return showEditMenu.call(ui, anchorPoint, triggerType, list);
      };
    }
  }

  try {
    bindShortcut(context, getState);
  } catch (error) {
    console.warn('[StravaHeatmapExt] Could not bind Slide shortcut', error);
  }
}
