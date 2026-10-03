# Strava Heatmap extension

This browser extension seamlessly integrates the [Strava Global Heatmap](https://www.strava.com/maps/global-heatmap) into popular mapping editors, including the OpenStreetMap [iD editor](https://www.openstreetmap.org/edit?editor=id) and [GPX Studio](https://gpx.studio/app), enhancing your mapping and route analysis capabilities.

<img src="./images/screenshot1.png" width="48%"/>&nbsp;<img src="./images/screenshot2.png" width="48%"/>

## Pre-requisites

### Strava account

If you don’t already have a Strava account, you’ll need to create one (free) to use the Strava Heatmap.

1. Go to https://www.strava.com/register/free
2. Sign up using Google, Apple, or your email

## Installation

### Chrome

Open the [Chrome extension page](https://chrome.google.com/webstore/detail/eglbcifjafncknmpmnelckombmgddlco) for the extension.

1. Click `Add to Chrome`.
2. Confirm permissions by selecting `Add extension`.
3. Chrome will briefly display a popup and show the new extension icon in the top-right toolbar.
4. Right-click the extension icon and choose `Pin` to keep it visible.
5. Alternatively, open the puzzle-piece Extensions menu and click the 📌 next to Strava Heatmap extension.

### Firefox

Open the [Firefox add-on](https://addons.mozilla.org/en-US/firefox/addon/strava-heatmap/) for the extension.

1. Click `Add to Firefox`.
2. Confirm permissions by selecting `Add`.
3. Chrome will briefly display a popup and show the new extension icon in the top-right toolbar.
4. Make sure `Pin extension to toolbar` is selected and click `OK`.
5. Alternatively, right-click the extension icon and choose `Pin` to keep it visible.

### Versions

See the [Changelog](./CHANGELOG.md) for details.

### Instructions

## OpenStreetMap iD editor

To enable the Strava Heatmap in the iD editor:

1. Open the iD editor: https://www.openstreetmap.org/edit?editor=id
2. Press B or click Background settings, then scroll to Overlays.
3. Select a Strava Heatmap overlay from the list.
4. If you see the message "Click the Strava Heatmap extension icon to log into Strava…", click the red extension icon to authenticate.
5. After logging in, use the green extension icon to configure heatmap layers — choose activity type, color, and manage layer order or deletion.
6. In the editor, press Shift + Q to toggle the heatmap, and Shift + W to toggle data visibility.

#### Slide to Heatmap

With a Strava Heatmap overlay switched on and the extension signed in, an
existing line can be snapped to the closest trace of that heatmap:

1. Right-click a line (way) in the editor to open the edit menu.
2. Choose **Slide to Heatmap**, or press Shift + S while the line is selected.
3. The line's interior vertices slide onto the nearest heatmap trace — the
   first and last vertex stay put — and the whole change is recorded as a
   single undoable step (Ctrl/Cmd + Z).

Details worth knowing:

- The action only appears while signed in to Strava; it is greyed out with an
  explanation when no Strava Heatmap overlay is enabled.
- The heatmap used is the one currently enabled in the overlay list, so the
  activity type and color you picked are honoured.
- Lines longer than about 7 km span more than the 3×3 heatmap tiles the
  operation fetches and are refused — split the line first.
- Untagged interior vertices are moved along the trace (new ones are added
  where the trace needs more detail). Vertices shared with other ways or
  carrying tags are preserved and snapped onto the resulting line instead.

---

### GPX.studio editor

To enable the Strava Heatmap in GPX.studio:

1. Open GPX.studio: https://gpx.studio/app
2. Hover over the layers menu icon then scroll to Overlays.
3. Choose a Strava Heatmap overlay from the list.
4. If you see the message "Click the Strava Heatmap extension icon to log into Strava…", click the red extension icon to authenticate.
5. Once logged in, use the green extension icon to configure, reorder, or delete heatmap layers by activity and color.

### Troubleshooting

**Q: “Click the Strava Heatmap extension icon to log into Strava and enable the heatmap.” — What does this mean?**  
**A:** This message appears if you're not logged in to Strava AND haven’t visited the [Strava Global Heatmap](https://www.strava.com/heatmap). Just click the extension icon to sign in and authorize access.

### Feature and Bug Requests

Submit issues and feature requests in the [Issues](https://github.com/julcnx/strava-heatmap-extension/issues) section above.

## Extension Background

Previously, accessing Strava heatmap in OpenStreetMap iD editor required a tedious process of extracting Strava website cookies and generating a temporary URL that would expire after a week.

The [JOSM Strava Heatmap Extension](https://github.com/zekefarwell/josm-strava-heatmap) simplified this process, but due to the lack of support for custom overlays in the iD editor, users could only add the URL as a custom background.

With this extension, you can now automatically access all Strava activities as Heatmap overlays, eliminating the need for manual URL management.

To learn more about using the Strava Heatmap in OpenStreetMap, visit the [Strava wiki](https://wiki.openstreetmap.org/wiki/Strava).

### Support for Other Sites

This extension currently supports the iD editor and [gpx.studio](https://gpx.studio). I'm not taking on additional sites at the moment. If you'd like to add support for another tool, feel free to fork the project.

- For JOSM, check out the [JOSM Strava Heatmap Extension](https://github.com/zekefarwell/josm-strava-heatmap).
- For RapidId, refer to the [RapId Power User Extension](https://github.com/emersonveenstra/rapid-power-user-extension/).

## Development

```sh
npm ci         # install the build tooling
npm test       # Slide feature tests (tile math, engine, way rewrite)
npm run build  # Chrome and Firefox zips into dist/
```

The "Slide to Heatmap" feature lives in
[`src/clients/www.openstreetmap.org/slide/`](./src/clients/www.openstreetmap.org/slide/):
`geometry.js`, `surface.js` and `slide.js` are a verbatim copy of
[jsSlide](https://github.com/paulmach/slide)'s JavaScript port, while `tiles.js`
(heatmap tiles → surface), `action.js` (slid path → iD way), `operation.js`
(the menu entry) and `install.js` (the `showEditMenu` hook) are the extension's
own. `src/content/slide-bridge.js` plus `src/background/tiles.js` proxy tile
requests when the page's own `fetch()` is blocked by CORS or CSP.
