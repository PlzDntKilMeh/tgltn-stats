// Both databases are read straight out of the browser via sql.js (SQLite
// compiled to WASM) — no offline export_snapmap_data.py step needed anymore.
// Point these at wherever you copied the two files relative to index.html.
const TELEMETRY_DB_URL = "telemetry_index.sqlite3.gz";
const MATCH_DB_URL = "match_index.sqlite3.gz";
const SQLJS_CDN_BASE = "https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/";

// Tiled map backgrounds, served from the pubg-map-tiles repo instead of a
// single 8192x8192 PNG per map — see https://github.com/PlzDntKilMeh/pubg-map-tiles
// Pinned to a commit (not @main): jsDelivr caches commit-pinned paths hard at
// the edge, while branch refs are proxied live to GitHub with much weaker
// caching — that was causing slow/sporadically-failing tile loads. Bump this
// hash after pushing new tiles.
const TILE_CDN_COMMIT = "9b3ffb3b3aa0cb0b6f9b840140f13f7f39ff40c0";
const TILE_CDN_BASE = `https://cdn.jsdelivr.net/gh/PlzDntKilMeh/pubg-map-tiles@${TILE_CDN_COMMIT}/maps`;
const MAP_TILE_SLUGS = {
  Baltic_Main: "erangel",
  Desert_Main: "miramar",
  Tiger_Main: "taego",
  Savage_Main: "sanhok",
  DihorOtok_Main: "vikendi",
  Neon_Main: "rondo",
  Kiki_Main: "deston",
  Chimera_Main: "paramo",
  Summerland_Main: "karakin",
  Haven_Main: "haven",
};

const mapThemes = {
  Baltic_Main: { name: "Erangel", base: "#315040", accent: "#8bb06c", water: "#21455f" },
  Desert_Main: { name: "Miramar", base: "#6c5430", accent: "#c29d64", water: "#35546d" },
  Tiger_Main: { name: "Taego", base: "#3e5235", accent: "#90b56a", water: "#2f5972" },
  Savage_Main: { name: "Sanhok", base: "#25523f", accent: "#77c48b", water: "#1b4d58" },
  DihorOtok_Main: { name: "Vikendi", base: "#5f686d", accent: "#cad6dc", water: "#6d8897" },
  Neon_Main: { name: "Rondo", base: "#4f4a34", accent: "#d7bb77", water: "#375868" },
  Kiki_Main: { name: "Deston", base: "#36404f", accent: "#84a8b8", water: "#2d5267" },
  Chimera_Main: { name: "Paramo", base: "#5d4032", accent: "#d49363", water: "#45545e" },
  Summerland_Main: { name: "Karakin", base: "#725842", accent: "#d8b78a", water: "#4f626f" },
  Haven_Main: { name: "Haven", base: "#36404f", accent: "#84a8b8", water: "#2d5267" },
  Italy_TDM_Main: { name: "TDM Italy", base: "#3f4f38", accent: "#c7d07d", water: "#31586a" },
  PillarCompound_Main: { name: "Pillar Compound", base: "#4c4335", accent: "#ddbf7d", water: "#3c5970" },
  MOD_Main: { name: "Training", base: "#415446", accent: "#9dc38a", water: "#32576f" },
};

const state = {
  manifest: null,
  mapsData: null,
  currentMapKey: null,
  currentData: null,
  filteredEvents: [],
  hoveredId: null,
  selectedId: null,
  renderItems: [],
  view: { zoom: 1, offsetX: 0, offsetY: 0, dragging: false, dragX: 0, dragY: 0 },
  didDrag: false,
  stackPoint: null,
  selectedModes: null,
  dateBounds: null,
};

// These modes are noisy/less-relevant by default (ranked/custom queues), so
// they start unchecked. Everything else in the manifest starts checked.
const modesExcludedByDefault = ["ibr", "landmark", "tdm", "slbtaego-fpp", "slbmiramar-fpp"];

const els = {
  buildInfo: document.getElementById("build-info"),
  mapSelect: document.getElementById("map-select"),
  typeSelect: document.getElementById("type-select"),
  youtubeSelect: document.getElementById("youtube-select"),
  searchInput: document.getElementById("search-input"),
  weaponInput: document.getElementById("weapon-input"),
  dateFromSlider: document.getElementById("date-from-slider"),
  dateToSlider: document.getElementById("date-to-slider"),
  dateFromLabel: document.getElementById("date-from-label"),
  dateToLabel: document.getElementById("date-to-label"),
  sizeInput: document.getElementById("size-input"),
  visibleCount: document.getElementById("visible-count"),
  killCount: document.getElementById("kill-count"),
  groggyCount: document.getElementById("groggy-count"),
  deathCount: document.getElementById("death-count"),
  modeSelect: document.getElementById("mode-select"),
  mapTitle: document.getElementById("map-title"),
  mapSubtitle: document.getElementById("map-subtitle"),
  selectionDetails: document.getElementById("selection-details"),
  hoverCard: document.getElementById("hover-card"),
  eventStack: document.getElementById("event-stack"),
  canvasWrap: document.getElementById("canvas-wrap"),
  canvas: document.getElementById("map-canvas"),
  youtubeModal: document.getElementById("youtube-modal"),
  youtubeContainer: document.getElementById("youtube-container"),
  youtubeWatchLink: document.getElementById("youtube-watch-link"),
  mapView: document.getElementById("map-view"),
  browseView: document.getElementById("browse-view"),
  navMapBtn: document.getElementById("nav-map-btn"),
  navBrowseBtn: document.getElementById("nav-browse-btn"),
  loadingOverlay: document.getElementById("loading-overlay"),
  loadingText: document.getElementById("loading-text"),
};

// mapKey -> tiles.json contents ({tileSize, maxZoom, format, ...}), once loaded.
const tileMeta = {};
const tileMetaPending = new Set();

// Decoded tile bitmaps add up fast (a 256x256 tile is ~256KB uncompressed,
// and a full zoom level is up to 1024 tiles) — across every zoom level a
// user has panned through, plus every map they've switched between, an
// unbounded cache runs the tab's memory into the hundreds of MB and keeps
// the GC busy enough to make panning feel laggy. Cap it as a shared LRU
// across all maps/zooms instead: "mapKey/z/x_y" -> HTMLImageElement, in
// least-to-most-recently-used insertion order.
const MAX_CACHED_TILES = 300;
const tileCache = new Map();
const tileLoading = new Set();
// "mapKey/z/x_y" -> retry count, or "dead" once retries are exhausted.
const tileFailCounts = {};
const MAX_TILE_RETRIES = 4;

function tileKey(mapKey, z, x, y) {
  return `${mapKey}/${z}/${x}_${y}`;
}

function touchTile(key, img) {
  tileCache.delete(key);
  tileCache.set(key, img);
  while (tileCache.size > MAX_CACHED_TILES) {
    tileCache.delete(tileCache.keys().next().value);
  }
}

function getYoutubeEmbed(url) {
  if (!url) return null;
  let embedUrl = url;
  try {
    const urlObj = new URL(url);
    let videoId = null;
    let t = urlObj.searchParams.get('t');
    
    if (urlObj.hostname.includes('youtube.com') && urlObj.searchParams.has('v')) {
      videoId = urlObj.searchParams.get('v');
    } else if (urlObj.hostname === 'youtu.be') {
      videoId = urlObj.pathname.substring(1);
    }
    
    if (videoId) {
      let startSeconds = 0;
      if (t) {
        const hMatch = t.match(/(\d+)h/);
        const mMatch = t.match(/(\d+)m/);
        const sMatch = t.match(/(\d+)s/);
        if (hMatch || mMatch || sMatch) {
          if (hMatch) startSeconds += parseInt(hMatch[1]) * 3600;
          if (mMatch) startSeconds += parseInt(mMatch[1]) * 60;
          if (sMatch) startSeconds += parseInt(sMatch[1]);
        } else {
          startSeconds = parseInt(t) || 0;
        }
      }
      return `https://www.youtube.com/embed/${videoId}?autoplay=1${startSeconds > 0 ? '&start=' + startSeconds : ''}`;
    }
  } catch (e) {}
  return null;
}

const ctx = els.canvas.getContext("2d");

function themeForMap(mapKey) {
  return mapThemes[mapKey] || { name: mapKey, base: "#425248", accent: "#b7c980", water: "#36586a" };
}

// Shared with data-browser.js (the Browse Data section) — both want raw
// PUBG telemetry codes like "WeapM416_C" turned into readable weapon names,
// so one fetch + lookup lives here instead of each keeping its own copy.
let damageTranslationDict = null;

async function fetchTranslations() {
  try {
    const response = await fetch("https://raw.githubusercontent.com/pubg/api-assets/refs/heads/master/dictionaries/telemetry/damageCauserName.json");
    if (response.ok) {
      damageTranslationDict = await response.json();
      if (state.currentData) applyFilters();
    }
  } catch (e) {
    console.warn("Failed to load translations from GitHub, falling back to raw IDs", e);
  }
}

function weaponDisplayName(rawId) {
  if (!rawId) return "";
  const friendly = damageTranslationDict && damageTranslationDict[rawId];
  return friendly && friendly !== rawId ? friendly : rawId;
}

function eventColor(event) {
  if (event.victimName === "TGLTN") return "#8b0000";
  return event.type === "kill" ? "#006400" : "#00008b";
}

function eventTitle(event) {
  if (event.type === "kill") {
    return `${event.actorName || "Unknown"} -> ${event.victimName || "Unknown"}`;
  }
  return `${event.actorName || "Unknown"} knocked ${event.victimName || "Unknown"}`;
}

function eventMeta(event) {
  return [weaponDisplayName(event.damageCauserName), event.matchId, formatEventTime(event.eventTime)].filter(Boolean).join(" | ");
}

// event_time is stored as an ISO-ish sortable string; render it as something
// a person can actually read at a glance, while keeping the raw value
// available via title="" for anyone who wants full precision.
function formatEventTime(raw) {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(raw);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Finds the oldest/newest event in the current map's data so the date-range
// slider's min/max track exactly what's actually selectable, instead of some
// arbitrary fixed span.
function computeDateBounds(events) {
  let min = Infinity;
  let max = -Infinity;
  for (const event of events) {
    const t = event.eventTimeMs;
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function makeSearchBlob(event) {
  return [
    event.actorName,
    event.victimName,
    event.finisherName,
    event.damageCauserName,
    event.damageReason,
    event.matchId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function resizeCanvas() {
  const rect = els.canvasWrap.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(400, Math.floor(rect.width * ratio));
  const height = Math.max(300, Math.floor(rect.height * ratio));
  if (els.canvas.width !== width || els.canvas.height !== height) {
    els.canvas.width = width;
    els.canvas.height = height;
  }
  render();
}

function resetView() {
  state.view.zoom = 1;
  state.view.offsetX = 0;
  state.view.offsetY = 0;
}

function transformPoint(point) {
  const width = els.canvas.width;
  const height = els.canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  return {
    x: (point.x - centerX) * state.view.zoom + centerX + state.view.offsetX,
    y: (point.y - centerY) * state.view.zoom + centerY + state.view.offsetY,
  };
}

function inverseTransformPoint(point) {
  const width = els.canvas.width;
  const height = els.canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  return {
    x: (point.x - centerX - state.view.offsetX) / state.view.zoom + centerX,
    y: (point.y - centerY - state.view.offsetY) / state.view.zoom + centerY,
  };
}

function project(event, bounds, width, height, anchor) {
  const x = anchor === "actor" ? event.actorX : event.pointX;
  const y = anchor === "actor" ? event.actorY : event.pointY;
  if (x == null || y == null) return null;
  const mapSize = Math.min(width, height);
  // PUBG map images use the game-world origin at the top-left. Keep the
  // original axis direction and scale against the full map, not event extents.
  const xRatio = x / bounds.maxX;
  const yRatio = y / bounds.maxY;
  const px = xRatio * mapSize + (width - mapSize) / 2;
  const py = yRatio * mapSize + (height - mapSize) / 2;
  return { x: px, y: py };
}

function eventPositions(event, bounds, width, height) {
  const tgltnIsVictim = event.victimName === "TGLTN";
  const anchor = project(event, bounds, width, height, tgltnIsVictim ? "victim" : "actor");
  const other = project(event, bounds, width, height, tgltnIsVictim ? "actor" : "victim");
  return { anchor, other };
}

// Base-space grid cell size for the hit-test index below. Comfortably bigger
// than the ~18-36px hit radius at zoom 1 so a query only ever needs to check
// a small neighborhood of cells, not the whole map.
const SPATIAL_GRID_CELL = 64;

function buildSpatialIndex(items) {
  const grid = new Map();
  for (const item of items) {
    const key = `${Math.floor(item.baseX / SPATIAL_GRID_CELL)},${Math.floor(item.baseY / SPATIAL_GRID_CELL)}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(item);
  }
  return grid;
}

// Items within `threshold` of (x, y) (base space), via the grid instead of
// scanning every item — the hover handler calls this on every mousemove, so
// with tens of thousands of events a linear scan there was real, constant
// per-pixel-of-mouse-movement cost.
function queryNearbyItems(x, y, threshold) {
  if (!state.renderIndex) return [];
  const minCx = Math.floor((x - threshold) / SPATIAL_GRID_CELL);
  const maxCx = Math.floor((x + threshold) / SPATIAL_GRID_CELL);
  const minCy = Math.floor((y - threshold) / SPATIAL_GRID_CELL);
  const maxCy = Math.floor((y + threshold) / SPATIAL_GRID_CELL);
  const results = [];
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const bucket = state.renderIndex.get(`${cx},${cy}`);
      if (bucket) results.push(...bucket);
    }
  }
  return results;
}

function buildRenderItems() {
  const width = els.canvas.width;
  const height = els.canvas.height;
  const bounds = state.currentData.bounds;
  state.renderItems = state.filteredEvents
    // Positions are kept in unscaled "base" map-square coordinates, not
    // screen coordinates — pan/zoom is applied at draw time via a canvas
    // transform (see applyViewTransform), same as the tile background. That
    // means buildRenderItems only needs to re-run when the underlying data,
    // filters, or canvas size change, never on every pan/zoom/hover frame.
    .map(event => {
      const positions = eventPositions(event, bounds, width, height);
      if (!positions.anchor) return null;
      return {
        ...event,
        baseX: positions.anchor.x,
        baseY: positions.anchor.y,
        otherBaseX: positions.other?.x,
        otherBaseY: positions.other?.y,
      };
    })
    .filter(Boolean);
  state.renderIndex = buildSpatialIndex(state.renderItems);
  state.renderItemsById = new Map(state.renderItems.map(item => [item.id, item]));
  pointPathCache = null; // stale now that renderItems is a new array
}

// Same transform drawBackground() applies for tiles — establishes it once so
// callers can draw directly in unscaled base coordinates.
function applyViewTransform(w, h) {
  ctx.translate(w / 2 + state.view.offsetX, h / 2 + state.view.offsetY);
  ctx.scale(state.view.zoom, state.view.zoom);
  ctx.translate(-w / 2, -h / 2);
}

// Visible rect in base coordinates, for culling off-screen points cheaply.
function visibleBaseRect(w, h, margin = 0) {
  const topLeft = inverseTransformPoint({ x: 0, y: 0 });
  const bottomRight = inverseTransformPoint({ x: w, y: h });
  return {
    minX: Math.min(topLeft.x, bottomRight.x) - margin,
    maxX: Math.max(topLeft.x, bottomRight.x) + margin,
    minY: Math.min(topLeft.y, bottomRight.y) - margin,
    maxY: Math.max(topLeft.y, bottomRight.y) + margin,
  };
}

function drawGradientFallback(theme, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, theme.base);
  grad.addColorStop(1, "#101611");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

// Fetches maps/<slug>/tiles.json once per map (bounds/zoom metadata for the
// tile pyramid) and repaints when it lands. Uses redrawFrame(), not render():
// arriving tiles/metadata never change filtered events or their screen
// positions, so there's no need to rebuild them on every arrival.
function ensureTileMeta(mapKey, slug) {
  if (tileMeta[mapKey] || tileMetaPending.has(mapKey)) return;
  tileMetaPending.add(mapKey);
  fetch(`${TILE_CDN_BASE}/${slug}/tiles.json`)
    .then(response => {
      if (!response.ok) throw new Error(`tiles.json ${response.status}`);
      return response.json();
    })
    .then(meta => {
      tileMeta[mapKey] = meta;
      if (state.currentMapKey === mapKey) scheduleRedraw();
    })
    .catch(() => {
      // Leave the gradient fallback in place.
    })
    .finally(() => tileMetaPending.delete(mapKey));
}

// Returns a cached tile image if ready, else kicks off a load (if one isn't
// already in flight) and returns null so drawBackground just skips that cell
// until it arrives. Transient failures (a cold jsDelivr cache, a dropped
// request under the burst of tiles a deep zoom needs at once) are retried a
// few times rather than blacklisting the tile forever — that permanent
// blacklist was the cause of tiles silently going missing at deep zoom.
function getTile(mapKey, slug, z, x, y, format) {
  const key = tileKey(mapKey, z, x, y);
  if (tileCache.has(key)) {
    const img = tileCache.get(key);
    touchTile(key, img);
    return img;
  }
  if (tileLoading.has(key) || tileFailCounts[key] === "dead") return null;

  tileLoading.add(key);
  const img = new Image();
  img.onload = () => {
    tileLoading.delete(key);
    touchTile(key, img);
    if (state.currentMapKey === mapKey) scheduleRedraw();
  };
  img.onerror = () => {
    tileLoading.delete(key);
    const attempts = (tileFailCounts[key] || 0) + 1;
    if (attempts >= MAX_TILE_RETRIES) {
      tileFailCounts[key] = "dead"; // likely a genuinely missing edge tile
    } else {
      tileFailCounts[key] = attempts; // retried next time this cell is needed
      if (state.currentMapKey === mapKey) scheduleRedraw();
    }
  };
  img.src = `${TILE_CDN_BASE}/${slug}/tiles/${z}/${x}_${y}.${format}`;
  return null;
}

function drawBackground(mapKey) {
  const theme = themeForMap(mapKey);
  const w = els.canvas.width;
  const h = els.canvas.height;
  const slug = MAP_TILE_SLUGS[mapKey];
  const meta = slug ? tileMeta[mapKey] : null;

  if (!meta) {
    drawGradientFallback(theme, w, h);
    if (slug) ensureTileMeta(mapKey, slug);
    return;
  }

  const mapSize = Math.min(w, h);
  const x0 = (w - mapSize) / 2;
  const y0 = (h - mapSize) / 2;

  // Pick the tile zoom level whose native resolution roughly matches the
  // current on-screen size of the map, then only draw the tiles actually
  // inside the viewport (found via the same transform used for events).
  const onScreenMapSize = mapSize * state.view.zoom;
  const idealTilesPerSide = onScreenMapSize / meta.tileSize;
  const z = clamp(Math.round(Math.log2(Math.max(1, idealTilesPerSide))), 0, meta.maxZoom);
  const tilesPerSide = 2 ** z;
  const tileUnitSize = mapSize / tilesPerSide;

  const visible = visibleBaseRect(w, h);

  const tx0 = clamp(Math.floor((visible.minX - x0) / tileUnitSize), 0, tilesPerSide - 1);
  const tx1 = clamp(Math.ceil((visible.maxX - x0) / tileUnitSize), 0, tilesPerSide - 1);
  const ty0 = clamp(Math.floor((visible.minY - y0) / tileUnitSize), 0, tilesPerSide - 1);
  const ty1 = clamp(Math.ceil((visible.maxY - y0) / tileUnitSize), 0, tilesPerSide - 1);

  ctx.save();
  applyViewTransform(w, h);

  // Each tile is its own drawImage() call, and floating-point rounding at
  // shared edges leaves a hairline gap (or mismatched anti-aliasing) between
  // adjacent tiles — visible as seam lines, worse the more the view is
  // zoomed in. Overlapping each tile into its neighbors by ~1 screen pixel
  // (converted to base units via /zoom, so it's consistently ~1px on screen
  // at any zoom level) hides that gap. Standard fix for canvas tile grids.
  const bleed = 1 / state.view.zoom;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const img = getTile(mapKey, slug, z, tx, ty, meta.format);
      if (!img) continue;
      const dx = x0 + tx * tileUnitSize;
      const dy = y0 + ty * tileUnitSize;
      ctx.drawImage(img, dx - bleed, dy - bleed, tileUnitSize + bleed * 2, tileUnitSize + bleed * 2);
    }
  }

  ctx.restore();
}

// Path2D objects built from renderItems, cached by (items, radius, zoom).
// A pre-rasterized bitmap (the same trick the map tiles use) was tried here
// instead, but it bakes dot size in at a fixed pixel resolution *before* the
// zoom transform stretches it — at high zoom (now up to 128x) that's
// blowing up an already sub-pixel circle into a blurry blob. Path2D stays
// vector until draw time, so it rasterizes crisp at any zoom level. Reusing
// the same Path2D object across repaints still avoids the actual expensive
// part (rebuilding it — a moveTo+arc per point, up to ~20k of them — on
// every single mousemove-driven repaint during a drag); only fill()'s own
// rasterization cost remains, and that scales with visible detail rather
// than blowing up like the bitmap did.
let pointPathCache = null;

function getPointPaths(items, radius, zoom) {
  if (
    pointPathCache &&
    pointPathCache.items === items &&
    pointPathCache.radius === radius &&
    pointPathCache.zoom === zoom
  ) {
    return pointPathCache;
  }
  const r = radius / zoom;
  const pathsByColor = new Map();
  items.forEach(item => {
    const color = eventColor(item);
    let path = pathsByColor.get(color);
    if (!path) {
      path = new Path2D();
      pathsByColor.set(color, path);
    }
    // moveTo first so this circle starts its own subpath — otherwise arc()
    // draws a connecting line back to the previous circle's edge, and
    // fill() would render that stray line too.
    path.moveTo(item.baseX + r, item.baseY);
    path.arc(item.baseX, item.baseY, r, 0, Math.PI * 2);
  });
  pointPathCache = { items, radius, zoom, pathsByColor };
  return pointPathCache;
}

// Drawn in base coordinates under the view transform (see
// applyViewTransform) so pan/zoom is free at draw time. eventColor() only
// returns 3 distinct colors, so every point is batched into one cached
// Path2D per color (see getPointPaths) and filled once per color, rather
// than once per dot. Selected/hovered points (0-2, via O(1) map lookup) are
// drawn again on top with a highlight ring, uniformly over every point
// rather than excluded from the batch — so hovering/selecting never has to
// invalidate or rebuild the cached paths.
function renderPoints(items, radius) {
  const w = els.canvas.width;
  const h = els.canvas.height;
  const ratio = window.devicePixelRatio || 1;
  const zoom = state.view.zoom;
  const r = radius / zoom;
  const { pathsByColor } = getPointPaths(items, radius, zoom);

  ctx.save();
  applyViewTransform(w, h);

  for (const [color, path] of pathsByColor) {
    ctx.fillStyle = color;
    ctx.fill(path);
  }

  [state.hoveredId, state.selectedId].forEach(id => {
    if (id == null) return;
    const item = state.renderItemsById && state.renderItemsById.get(id);
    if (!item) return;
    const selected = id === state.selectedId;
    const itemR = r + (selected ? 3 / zoom : 2 / zoom);
    ctx.beginPath();
    ctx.arc(item.baseX, item.baseY, itemR, 0, Math.PI * 2);
    ctx.fillStyle = eventColor(item);
    ctx.fill();
    ctx.lineWidth = Math.max(1, ratio) / zoom;
    ctx.strokeStyle = "rgba(8, 12, 8, 0.6)";
    ctx.stroke();
    ctx.lineWidth = (selected ? 3 : 2) / zoom;
    ctx.strokeStyle = "#fff6d2";
    ctx.stroke();
  });

  ctx.restore();
}

function renderSelectedLine() {
  const id = state.hoveredId || state.selectedId;
  const selected = id != null && state.renderItemsById && state.renderItemsById.get(id);
  if (!selected || selected.otherBaseX == null || selected.otherBaseY == null) return;
  const w = els.canvas.width;
  const h = els.canvas.height;
  const ratio = window.devicePixelRatio || 1;
  const zoom = state.view.zoom;

  ctx.save();
  applyViewTransform(w, h);

  // Dark outline underneath so the line reads over light map backgrounds too.
  ctx.strokeStyle = "rgba(4, 6, 4, 0.75)";
  ctx.lineWidth = (8 * ratio) / zoom;
  ctx.setLineDash([(10 * ratio) / zoom, (7 * ratio) / zoom]);
  ctx.beginPath();
  ctx.moveTo(selected.baseX, selected.baseY);
  ctx.lineTo(selected.otherBaseX, selected.otherBaseY);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 246, 210, 0.95)";
  ctx.lineWidth = (4 * ratio) / zoom;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(selected.baseX, selected.baseY);
  ctx.lineTo(selected.otherBaseX, selected.otherBaseY);
  ctx.stroke();

  ctx.fillStyle = "#8b5cf6";
  ctx.beginPath();
  ctx.arc(selected.otherBaseX, selected.otherBaseY, (7 * ratio) / zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c4b5fd";
  ctx.beginPath();
  ctx.arc(selected.otherBaseX, selected.otherBaseY, (4 * ratio) / zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderStackPoint() {
  if (!state.stackPoint) return;
  const ratio = window.devicePixelRatio || 1;
  const point = transformPoint({ x: state.stackPoint.baseX, y: state.stackPoint.baseY });
  ctx.save();
  ctx.strokeStyle = "#fff6d2";
  ctx.lineWidth = 3 * ratio;
  ctx.setLineDash([6 * ratio, 5 * ratio]);
  ctx.beginPath();
  ctx.arc(point.x, point.y, 22 * ratio, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

let redrawScheduled = false;

// Coalesces repaint requests into one per animation frame — a fast drag or
// scroll-wheel zoom can fire mousemove/wheel events faster than the screen
// actually refreshes, and without this each one forced its own synchronous
// redraw even though only the last one before each frame is ever visible.
function scheduleRedraw() {
  if (redrawScheduled) return;
  redrawScheduled = true;
  requestAnimationFrame(() => {
    redrawScheduled = false;
    redrawFrame();
  });
}

// Repaints using the last-computed renderItems, without recomputing them.
// Safe whenever only the background changed (a tile/tiles.json arriving) —
// canvas size, pan/zoom, filters, and selection didn't move. Call
// scheduleRedraw() instead unless you specifically need a synchronous paint.
function redrawFrame() {
  if (!state.currentData) return;
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  drawBackground(state.currentMapKey);
  renderPoints(state.renderItems, Number(els.sizeInput.value) * (window.devicePixelRatio || 1));
  renderSelectedLine();
  renderStackPoint();
}

function render() {
  if (!state.currentData) return;
  buildRenderItems();
  redrawFrame();
}

function updateSelection() {
  const event = state.filteredEvents.find(row => row.id === state.selectedId);
  if (!event) {
    els.selectionDetails.className = "detail-body muted";
    els.selectionDetails.textContent = "Click a point to inspect an event. Ctrl+click to see everything at a point.";
    return;
  }
  els.selectionDetails.className = "detail-body";
  
  let youtubeHtml = "";
  const actualYoutubeUrl = event.youtubeUrl || null;
  
  if (actualYoutubeUrl) {
    const embed = getYoutubeEmbed(actualYoutubeUrl);
    if (embed) {
      youtubeHtml = `<button class="youtube-button" type="button" data-youtube-embed="${encodeURIComponent(embed)}">Watch clip</button>`;
    } else {
      youtubeHtml = `<a href="${actualYoutubeUrl}" target="_blank" rel="noopener noreferrer">Open YouTube link</a>`;
    }
  }

  const eventLabel = event.victimName === "TGLTN" ? "Death" : event.type === "kill" ? "Kill" : "Groggy";
  els.selectionDetails.innerHTML = [
    `<strong>${escapeHtml(eventTitle(event))}</strong>`,
    `${eventLabel} on ${escapeHtml(formatEventTime(event.eventTime))}`,
    `Map: ${escapeHtml(event.mapName || state.currentMapKey)}`,
    event.matchId ? `Match: ${escapeHtml(event.matchId)}` : "",
    event.finisherName && event.finisherName !== event.actorName ? `Finisher: ${escapeHtml(event.finisherName)}` : "",
    event.damageCauserName ? `Cause: ${escapeHtml(weaponDisplayName(event.damageCauserName))}` : "",
    event.distance != null ? `Distance: ${Number(event.distance).toFixed(1)} m` : "",
  ].filter(Boolean).join("<br>") + youtubeHtml;

  const youtubeButton = els.selectionDetails.querySelector("[data-youtube-embed]");
  if (youtubeButton) {
    youtubeButton.addEventListener("click", () => openYoutubeModal(
      decodeURIComponent(youtubeButton.dataset.youtubeEmbed),
      actualYoutubeUrl,
    ));
  }
}

function openYoutubeModal(embedUrl, youtubeUrl = "") {
  if (youtubeUrl) {
    els.youtubeWatchLink.href = youtubeUrl;
    els.youtubeWatchLink.classList.remove("hidden");
  } else {
    els.youtubeWatchLink.removeAttribute("href");
    els.youtubeWatchLink.classList.add("hidden");
  }

  const iframe = document.createElement("iframe");
  iframe.src = embedUrl;
  iframe.title = "YouTube clip";
  iframe.allow = "autoplay; encrypted-media";
  iframe.allowFullscreen = true;
  els.youtubeContainer.replaceChildren(iframe);

  els.youtubeModal.classList.remove("hidden");
}

function closeYoutubeModal() {
  els.youtubeModal.classList.add("hidden");
  els.youtubeContainer.replaceChildren();
  els.youtubeWatchLink.classList.add("hidden");
}

function updateStats() {
  const deaths = state.filteredEvents.filter(event => event.victimName === "TGLTN").length;
  const kills = state.filteredEvents.filter(event => event.type === "kill" && event.victimName !== "TGLTN").length;
  const groggies = state.filteredEvents.filter(event => event.type === "groggy" && event.victimName !== "TGLTN").length;
  
  els.visibleCount.textContent = state.filteredEvents.length.toLocaleString();
  els.killCount.textContent = kills.toLocaleString();
  els.groggyCount.textContent = groggies.toLocaleString();
  if (els.deathCount) els.deathCount.textContent = deaths.toLocaleString();
}

function applyFilters() {
  if (!state.currentData) return;
  const type = els.typeSelect.value;
  const youtube = els.youtubeSelect.value;
  const search = els.searchInput.value.trim().toLowerCase();
  const weapon = els.weaponInput.value.trim().toLowerCase();
  const bounds = state.dateBounds;
  let fromTime = null;
  let toTime = null;
  if (bounds) {
    const sliderFrom = Number(els.dateFromSlider.value);
    const sliderTo = Number(els.dateToSlider.value);
    if (sliderFrom > bounds.min) fromTime = sliderFrom;
    if (sliderTo < bounds.max) toTime = sliderTo;
  }
  state.filteredEvents = state.currentData.events.filter(event => {
    const hasYoutube = Boolean(event.youtubeUrl);
    if (youtube === "with" && !hasYoutube) return false;
    if (youtube === "without" && hasYoutube) return false;
    if (state.selectedModes && !state.selectedModes.has(event.mode)) return false;
    const isDeath = event.victimName === "TGLTN";
    const isKill = event.type === "kill" && !isDeath;
    const isGroggy = event.type === "groggy" && !isDeath;

    if (type === "death" && !isDeath) return false;
    if (type === "kill" && !isKill) return false;
    if (type === "groggy" && !isGroggy) return false;

    if (fromTime != null || toTime != null) {
      if (!Number.isFinite(event.eventTimeMs)) return false;
      if (fromTime != null && event.eventTimeMs < fromTime) return false;
      if (toTime != null && event.eventTimeMs > toTime) return false;
    }

    if (weapon) {
      const rawMatch = (event.damageCauserName || "").toLowerCase().includes(weapon);
      const friendlyMatch = weaponDisplayName(event.damageCauserName).toLowerCase().includes(weapon);
      if (!rawMatch && !friendlyMatch) return false;
    }
    if (search && !event.searchBlob.includes(search)) return false;
    return true;
  });

  if (!state.filteredEvents.some(event => event.id === state.selectedId)) {
    state.selectedId = null;
  }

  updateStats();
  updateSelection();
  render();
}

function getMapBounds(mapKey) {
  const sizeMap = {
    Baltic_Main: 816000,
    Desert_Main: 816000,
    Tiger_Main: 816000,
    DihorOtok_Main: 816000,
    Kiki_Main: 816000,
    Savage_Main: 408000,
    Chimera_Main: 306000,
    Summerland_Main: 204000,
    Range_Main: 204000,
    Haven_Main: 102000
  };
  const size = sizeMap[mapKey] || 816000;
  return { minX: 0, minY: 0, maxX: size, maxY: size };
}

let sqlJsEnginePromise = null;

function loadSqlEngine() {
  if (!sqlJsEnginePromise) {
    sqlJsEnginePromise = (async () => {
      if (typeof initSqlJs !== "function") {
        throw new Error("sql.js didn't load — check the <script> tag / network access in index.html");
      }
      return initSqlJs({ locateFile: file => `${SQLJS_CDN_BASE}${file}` });
    })();
  }
  return sqlJsEnginePromise;
}

// Transparently gunzips gzip-magic-byte responses; both DB files are gzipped
// today, but this also passes a plain (non-gzipped) sqlite file through
// untouched, so it doesn't assume that stays true.
async function fetchDbBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Couldn't fetch ${url} (${response.status}) — is it next to index.html?`);
  }
  const buffer = await response.arrayBuffer();
  const header = new Uint8Array(buffer.slice(0, 2));
  const isGzip = header[0] === 0x1f && header[1] === 0x8b;
  if (!isGzip) return buffer;

  if (!("DecompressionStream" in window)) {
    throw new Error("This browser does not support gzip decompression.");
  }
  const decompressedStream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressedStream).arrayBuffer();
}

async function fetchDb(SQL, url) {
  const buffer = await fetchDbBytes(url);
  return new SQL.Database(new Uint8Array(buffer));
}

// Shared with data-browser.js (the Browse Data section) — both it and the
// map need telemetry_index.sqlite3.gz loaded into a sql.js Database, and
// both only ever run read queries against it, so one shared instance is
// safe. Caching the promise here means whichever one asks first triggers
// the actual fetch+decompress+parse, and the other just awaits the same
// result — instead of each independently downloading and parsing its own
// copy of the same 15MB file.
let telemetryDbPromise = null;
function getTelemetryDb() {
  if (!telemetryDbPromise) {
    telemetryDbPromise = (async () => {
      const SQL = await loadSqlEngine();
      return fetchDb(SQL, TELEMETRY_DB_URL);
    })();
  }
  return telemetryDbPromise;
}

// sql.js returns column-oriented result sets; zip them into row objects so
// the rest of the code can keep working with plain event-shaped objects.
function queryRows(db, sql) {
  const result = db.exec(sql);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
}

// Mirrors normalize_event() from export_snapmap_data.py, field for field.
function normalizeEvent(row, type, modeByMatchId) {
  const mode = modeByMatchId.get(row.match_id) || "unknown";
  if (type === "kill") {
    return {
      id: `kill:${row.id}`,
      type: "kill",
      eventTime: row.event_time,
      eventTimeMs: Date.parse(row.event_time),
      matchId: row.match_id || "",
      mode,
      mapName: row.map_name || "",
      youtubeUrl: row.youtube_url || "",
      actorName: row.killer_name || "",
      victimName: row.victim_name || "",
      finisherName: row.finisher_name || "",
      damageCauserName: row.finishDamageInfo_damageCauserName || row.killerDamageInfo_damageCauserName || "",
      damageReason: row.finishDamageInfo_damageReason || row.killerDamageInfo_damageReason || "",
      distance: row.finishDamageInfo_distance || row.killerDamageInfo_distance,
      pointX: row.victim_location_x,
      pointY: row.victim_location_y,
      pointZ: row.victim_location_z,
      actorX: row.killer_location_x,
      actorY: row.killer_location_y,
      actorZ: row.killer_location_z,
    };
  }
  return {
    id: `groggy:${row.id}`,
    type: "groggy",
    eventTime: row.event_time,
    eventTimeMs: Date.parse(row.event_time),
    matchId: row.match_id || "",
    mode,
    mapName: row.map_name || "",
    youtubeUrl: row.youtube_url || "",
    actorName: row.attacker_name || "",
    victimName: row.victim_name || "",
    finisherName: "",
    damageCauserName: row.damageCauserName || "",
    damageReason: row.damageReason || "",
    distance: row.distance,
    pointX: row.victim_location_x,
    pointY: row.victim_location_y,
    pointZ: row.victim_location_z,
    actorX: row.attacker_location_x,
    actorY: row.attacker_location_y,
    actorZ: row.attacker_location_z,
  };
}

// Runs the same queries + grouping export_snapmap_data.py used to do
// offline, but in the browser, once, at startup. Returns a manifest (for the
// map/mode pickers) plus a per-map payload cache used directly by loadMap().
async function buildDataset() {
  const SQL = await loadSqlEngine();
  const [telemetryDb, matchDb] = await Promise.all([
    getTelemetryDb(),
    fetchDb(SQL, MATCH_DB_URL),
  ]);

  const modeByMatchId = new Map();
  queryRows(matchDb, "SELECT match_id, game_mode FROM match_stats").forEach(row => {
    modeByMatchId.set(row.match_id, row.game_mode || "");
  });
  matchDb.close();

  const killRows = queryRows(telemetryDb, `
    SELECT
      id, event_time, match_id, map_name, youtube_url,
      killer_name, killer_location_x, killer_location_y, killer_location_z,
      victim_name, victim_location_x, victim_location_y, victim_location_z,
      finisher_name,
      finishDamageInfo_damageCauserName, finishDamageInfo_damageReason, finishDamageInfo_distance,
      killerDamageInfo_damageCauserName, killerDamageInfo_damageReason, killerDamageInfo_distance
    FROM kill_v2_events
    WHERE victim_location_x IS NOT NULL AND victim_location_y IS NOT NULL
  `);

  const groggyRows = queryRows(telemetryDb, `
    SELECT
      id, event_time, match_id, map_name, youtube_url,
      attacker_name, attacker_location_x, attacker_location_y, attacker_location_z,
      victim_name, victim_location_x, victim_location_y, victim_location_z,
      damageCauserName, damageReason, distance
    FROM groggy_events
    WHERE victim_location_x IS NOT NULL AND victim_location_y IS NOT NULL
  `);

  // Not closed: this instance is shared (see getTelemetryDb) — the Browse
  // Data section reuses this exact connection instead of fetching and
  // parsing its own separate copy of the same file.

  const grouped = new Map();
  const addEvent = event => {
    if (!grouped.has(event.mapName)) grouped.set(event.mapName, []);
    grouped.get(event.mapName).push(event);
  };
  killRows.forEach(row => addEvent(normalizeEvent(row, "kill", modeByMatchId)));
  groggyRows.forEach(row => addEvent(normalizeEvent(row, "groggy", modeByMatchId)));

  const mapsData = {};
  const manifestMaps = [];
  const allModes = new Set();
  let totalEvents = 0;

  [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([mapKey, events]) => {
      events.sort((a, b) => (a.eventTime < b.eventTime ? 1 : a.eventTime > b.eventTime ? -1 : 0));
      events.forEach(event => {
        event.searchBlob = makeSearchBlob(event);
        allModes.add(event.mode);
      });

      const kills = events.filter(event => event.type === "kill").length;
      const matchIds = new Set(events.map(event => event.matchId).filter(Boolean));
      const payload = {
        key: mapKey,
        displayName: themeForMap(mapKey).name,
        modes: [...new Set(events.map(event => event.mode))].sort(),
        bounds: getMapBounds(mapKey),
        totalCount: events.length,
        killCount: kills,
        groggyCount: events.length - kills,
        matchCount: matchIds.size,
        events,
      };

      mapsData[mapKey] = payload;
      manifestMaps.push({
        key: mapKey,
        displayName: payload.displayName,
        totalCount: payload.totalCount,
        killCount: payload.killCount,
        groggyCount: payload.groggyCount,
        matchCount: payload.matchCount,
        modes: payload.modes,
      });
      totalEvents += events.length;
    });

  return {
    manifest: {
      generatedAt: new Date().toISOString(),
      totalEvents,
      modes: [...allModes].sort(),
      maps: manifestMaps,
    },
    mapsData,
  };
}

async function loadMap(mapKey) {
  const payload = state.mapsData && state.mapsData[mapKey];
  if (!payload) return;

  state.currentMapKey = mapKey;
  state.currentData = payload;
  resetView();
  const theme = themeForMap(mapKey);
  els.mapTitle.textContent = theme.name;
  els.mapSubtitle.textContent = `${payload.totalCount.toLocaleString()} indexed events across ${payload.matchCount.toLocaleString()} matches`;

  state.dateBounds = computeDateBounds(payload.events);
  setupDateRangeSlider();

  const slug = MAP_TILE_SLUGS[mapKey];
  if (slug) ensureTileMeta(mapKey, slug);
  applyFilters();
}

// Resets both handles to the full span every time a new map's data loads —
// each map has its own event history, so yesterday's selected range from a
// different map wouldn't mean anything here.
function setupDateRangeSlider() {
  const bounds = state.dateBounds;
  if (!bounds) return;
  [els.dateFromSlider, els.dateToSlider].forEach(slider => {
    slider.min = String(bounds.min);
    slider.max = String(bounds.max);
    slider.step = "1000";
  });
  els.dateFromSlider.value = String(bounds.min);
  els.dateToSlider.value = String(bounds.max);
  updateDateRangeLabels();
}

function syncDateRangeHandles(changedSlider) {
  if (Number(els.dateFromSlider.value) > Number(els.dateToSlider.value)) {
    if (changedSlider === els.dateFromSlider) {
      els.dateToSlider.value = els.dateFromSlider.value;
    } else {
      els.dateFromSlider.value = els.dateToSlider.value;
    }
  }
}

function updateDateRangeLabels() {
  els.dateFromLabel.textContent = formatEventTime(Number(els.dateFromSlider.value));
  els.dateToLabel.textContent = formatEventTime(Number(els.dateToSlider.value));
}

// Items only carry base (unscaled) coordinates now, so hit-testing converts
// the click point into base space instead — the 18px hit radius has to
// shrink by the same amount in base space (divide by zoom) to still mean
// "18 screen pixels" at any zoom level.
function clientToBase(clientX, clientY) {
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  return inverseTransformPoint({
    x: (clientX - rect.left) * ratio,
    y: (clientY - rect.top) * ratio,
  });
}

function findNearestEvent(clientX, clientY) {
  const ratio = window.devicePixelRatio || 1;
  const { x, y } = clientToBase(clientX, clientY);
  const thresholdBase = (18 * ratio) / state.view.zoom;
  let best = null;
  let bestDistance = Infinity;
  for (const item of queryNearbyItems(x, y, thresholdBase)) {
    const dx = item.baseX - x;
    const dy = item.baseY - y;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return bestDistance <= thresholdBase ? best : null;
}

function eventsNear(clientX, clientY) {
  const ratio = window.devicePixelRatio || 1;
  const { x, y } = clientToBase(clientX, clientY);
  const thresholdBase = (18 * ratio) / state.view.zoom;
  return queryNearbyItems(x, y, thresholdBase).filter(
    item => Math.hypot(item.baseX - x, item.baseY - y) <= thresholdBase
  );
}

function hideEventStack() {
  state.stackPoint = null;
  els.eventStack.classList.add("hidden");
  scheduleRedraw();
}

function showEventStack(events, clientX, clientY) {
  els.eventStack.replaceChildren();

  const sortedEvents = [...events].sort((a, b) =>
    a.eventTime < b.eventTime ? -1 : a.eventTime > b.eventTime ? 1 : 0
  );

  const header = document.createElement("div");
  header.className = "event-stack-header";

  const heading = document.createElement("strong");
  heading.textContent = `${sortedEvents.length} event${sortedEvents.length === 1 ? "" : "s"} here`;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "event-stack-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", hideEventStack);

  header.appendChild(heading);
  header.appendChild(closeBtn);
  els.eventStack.appendChild(header);

  const list = document.createElement("div");
  list.className = "event-stack-list";

  sortedEvents.forEach(event => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "event-stack-item";

    const dot = document.createElement("span");
    dot.className = "event-stack-dot";
    dot.style.background = eventColor(event);

    const body = document.createElement("span");
    body.className = "event-stack-body";

    const title = document.createElement("span");
    title.className = "event-stack-title";
    title.textContent = eventTitle(event);

    body.appendChild(title);

    const weaponName = weaponDisplayName(event.damageCauserName);
    if (weaponName) {
      const weaponLine = document.createElement("span");
      weaponLine.className = "event-stack-meta";
      weaponLine.textContent = weaponName;
      body.appendChild(weaponLine);
    }

    const timeLine = document.createElement("span");
    timeLine.className = "event-stack-time";
    timeLine.textContent = formatEventTime(event.eventTime);
    timeLine.title = event.eventTime || "";
    body.appendChild(timeLine);

    button.appendChild(dot);
    button.appendChild(body);

    const ytBadge = document.createElement("span");
    ytBadge.className = event.youtubeUrl ? "event-stack-yt has-clip" : "event-stack-yt no-clip";
    ytBadge.title = event.youtubeUrl ? "Has a YouTube clip" : "No YouTube clip";
    button.appendChild(ytBadge);

    button.addEventListener("click", () => {
      state.selectedId = event.id;
      updateSelection();
      scheduleRedraw();
      const embed = getYoutubeEmbed(event.youtubeUrl);
      if (embed) openYoutubeModal(embed, event.youtubeUrl);
    });
    button.addEventListener("mouseenter", () => {
      state.hoveredId = event.id;
      scheduleRedraw();
    });
    button.addEventListener("mouseleave", () => {
      state.hoveredId = null;
      scheduleRedraw();
    });
    list.appendChild(button);
  });

  els.eventStack.appendChild(list);
  els.eventStack.classList.remove("hidden");
}

function updateHoverCard(event, clientX, clientY) {
  // Plain mouse movement over the canvas re-fires this on every pixel, and a
  // canvas redraw isn't free even with everything else cached — only redraw
  // when the actually highlighted dot changes. The tooltip's own position
  // can still update every time since that's a cheap DOM style set, not a
  // canvas redraw.
  const nextHoveredId = event ? event.id : null;
  const hoveredChanged = nextHoveredId !== state.hoveredId;

  if (!event) {
    if (hoveredChanged) {
      state.hoveredId = null;
      els.hoverCard.classList.add("hidden");
      scheduleRedraw();
    }
    return;
  }

  state.hoveredId = event.id;
  els.hoverCard.innerHTML = `<strong>${escapeHtml(eventTitle(event))}</strong><br>${escapeHtml(eventMeta(event))}`;
  els.hoverCard.style.left = `${clientX - els.canvasWrap.getBoundingClientRect().left}px`;
  els.hoverCard.style.top = `${clientY - els.canvasWrap.getBoundingClientRect().top}px`;
  els.hoverCard.classList.remove("hidden");
  if (hoveredChanged) scheduleRedraw();
}

// Text inputs otherwise re-filter + rebuild renderItems (a full pass over
// every event, spreading each one — expensive on this app's 20k+ events per
// map) on every single keystroke. Debouncing means one rebuild after typing
// pauses, not one per character.
function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function showMapView() {
  els.browseView.classList.add("hidden");
  els.mapView.classList.remove("hidden");
  els.navBrowseBtn.classList.remove("active");
  els.navMapBtn.classList.add("active");
}

function showBrowseView() {
  els.mapView.classList.add("hidden");
  els.browseView.classList.remove("hidden");
  els.navMapBtn.classList.remove("active");
  els.navBrowseBtn.classList.add("active");
}

function bindEvents() {
  els.navMapBtn.addEventListener("click", showMapView);
  els.navBrowseBtn.addEventListener("click", showBrowseView);

  // Lets index.html's "Browse data" link (map.html#browse) drop straight
  // into that view instead of landing on the map first.
  if (window.location.hash === "#browse") showBrowseView();

  [els.typeSelect, els.youtubeSelect].forEach(el => el.addEventListener("input", applyFilters));

  const debouncedApplyFilters = debounce(applyFilters, 200);
  [els.searchInput, els.weaponInput].forEach(el => el.addEventListener("input", debouncedApplyFilters));

  // Labels update every tick for immediate drag feedback; the actual
  // refilter + render pass (expensive over 20k+ events) is debounced since
  // "input" fires continuously while dragging.
  [els.dateFromSlider, els.dateToSlider].forEach(slider => {
    slider.addEventListener("input", () => {
      syncDateRangeHandles(slider);
      updateDateRangeLabels();
      debouncedApplyFilters();
    });
  });

  // Point size only affects the radius passed to renderPoints() at draw
  // time — it doesn't change what's filtered or where anything is
  // positioned, so dragging this slider only needs a repaint, not a full
  // refilter + position rebuild on every tick.
  els.sizeInput.addEventListener("input", scheduleRedraw);

  els.youtubeModal.querySelector(".close-modal").addEventListener("click", closeYoutubeModal);
  els.youtubeModal.addEventListener("click", event => {
    if (event.target === els.youtubeModal) closeYoutubeModal();
  });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape") closeYoutubeModal();
  });

  els.mapSelect.addEventListener("change", () => {
    state.selectedId = null;
    state.hoveredId = null;
    loadMap(els.mapSelect.value);
  });

  els.canvas.addEventListener("mousemove", event => {
    const nearest = findNearestEvent(event.clientX, event.clientY);
    updateHoverCard(nearest, event.clientX, event.clientY);
  });

  els.canvas.addEventListener("mouseleave", () => {
    updateHoverCard(null, 0, 0);
  });

  els.canvas.addEventListener("click", event => {
    if (state.didDrag) {
      state.didDrag = false;
      return;
    }
    const nearest = findNearestEvent(event.clientX, event.clientY);
    const nearby = eventsNear(event.clientX, event.clientY);
    if (event.ctrlKey) {
      if (nearby.length) {
        const basePoint = clientToBase(event.clientX, event.clientY);
        state.stackPoint = { baseX: basePoint.x, baseY: basePoint.y };
        showEventStack(nearby, event.clientX, event.clientY);
        scheduleRedraw();
      }
      return;
    }
    state.stackPoint = null;
    els.eventStack.classList.add("hidden");
    state.selectedId = nearest ? nearest.id : null;
    updateSelection();
    scheduleRedraw();
    if (nearest) {
      const embed = getYoutubeEmbed(nearest.youtubeUrl);
      if (embed) openYoutubeModal(embed, nearest.youtubeUrl);
    }
  });

  els.canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const pointer = {
      x: (event.clientX - rect.left) * ratio,
      y: (event.clientY - rect.top) * ratio,
    };
    const anchor = inverseTransformPoint(pointer);
    const zoomFactor = event.deltaY < 0 ? 1.12 : 0.9;
    state.view.zoom = clamp(state.view.zoom * zoomFactor, 0.7, 128);
    const moved = transformPoint(anchor);
    state.view.offsetX += pointer.x - moved.x;
    state.view.offsetY += pointer.y - moved.y;
    scheduleRedraw();
  }, { passive: false });

  els.canvas.addEventListener("mousedown", event => {
    state.view.dragging = true;
    state.didDrag = false;
    state.view.dragX = event.clientX;
    state.view.dragY = event.clientY;
  });

  window.addEventListener("mousemove", event => {
    if (!state.view.dragging) return;
    if (Math.hypot(event.clientX - state.view.dragX, event.clientY - state.view.dragY) > 4) {
      state.didDrag = true;
    }
    const ratio = window.devicePixelRatio || 1;
    state.view.offsetX += (event.clientX - state.view.dragX) * ratio;
    state.view.offsetY += (event.clientY - state.view.dragY) * ratio;
    state.view.dragX = event.clientX;
    state.view.dragY = event.clientY;
    scheduleRedraw();
  });

  window.addEventListener("mouseup", () => {
    state.view.dragging = false;
  });

  window.addEventListener("keydown", event => {
    if (event.key.toLowerCase() === "r") {
      resetView();
      scheduleRedraw();
    }
  });

  // Watch the canvas's own container instead of window "resize". The
  // YouTube modal can momentarily grow taller than the viewport (toggling
  // the page scrollbar), which fires a window resize even though the
  // canvas wrapper itself hasn't changed size — that was causing the map
  // to visibly re-render/resize every time a clip was opened or closed.
  // ResizeObserver only fires when canvas-wrap itself actually changes.
  const canvasResizeObserver = new ResizeObserver(() => resizeCanvas());
  canvasResizeObserver.observe(els.canvasWrap);
}

function populateMapSelect() {
  const currentKey = els.mapSelect.value || (state.manifest && state.manifest.maps[0].key);
  els.mapSelect.innerHTML = "";
  let maps = state.manifest.maps;
  
  maps.forEach(mapInfo => {
    const option = document.createElement("option");
    option.value = mapInfo.key;
    option.textContent = `${themeForMap(mapInfo.key).name} (${mapInfo.totalCount.toLocaleString()})`;
    els.mapSelect.appendChild(option);
  });

  if (maps.some(m => m.key === currentKey)) {
    els.mapSelect.value = currentKey;
  } else if (maps.length > 0) {
    els.mapSelect.value = maps[0].key;
  }
  // NOTE: intentionally not calling loadMap here — the caller decides when
  // to load (init() awaits it once explicitly; the change listener handles
  // subsequent switches). Calling it here too caused two concurrent loads
  // of the same map on startup.
}

function populateModeSelect() {
  const allModes = state.manifest.modes || [];

  // Only seed default selection once; preserve user's picks across map switches.
  if (!state.selectedModes) {
    state.selectedModes = new Set(allModes.filter(mode => !modesExcludedByDefault.includes(mode)));
  }

  const group = document.createElement("div");
  group.className = "mode-checkbox-group";
  group.id = "mode-checkbox-group";

  const selectAllBtn = document.createElement("button");
  selectAllBtn.type = "button";
  selectAllBtn.className = "mode-toggle-all";
  selectAllBtn.textContent = "All";
  selectAllBtn.addEventListener("click", () => {
    allModes.forEach(mode => state.selectedModes.add(mode));
    group.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = true; });
    applyFilters();
  });

  const selectNoneBtn = document.createElement("button");
  selectNoneBtn.type = "button";
  selectNoneBtn.className = "mode-toggle-all";
  selectNoneBtn.textContent = "None";
  selectNoneBtn.addEventListener("click", () => {
    state.selectedModes.clear();
    group.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = false; });
    applyFilters();
  });

  group.appendChild(selectAllBtn);
  group.appendChild(selectNoneBtn);

  allModes.forEach(mode => {
    const label = document.createElement("label");
    label.className = "mode-checkbox";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = mode;
    input.checked = state.selectedModes.has(mode);
    input.addEventListener("change", () => {
      if (input.checked) state.selectedModes.add(mode);
      else state.selectedModes.delete(mode);
      applyFilters();
    });

    const pill = document.createElement("span");
    pill.className = "mode-checkbox-pill";
    pill.textContent = mode;

    label.appendChild(input);
    label.appendChild(pill);
    group.appendChild(label);
  });

  els.modeSelect.replaceWith(group);
  els.modeSelect = group;
}

async function init() {
  bindEvents();
  fetchTranslations();
  els.buildInfo.textContent = "Loading telemetry databases…";
  els.loadingText.textContent = "Loading telemetry databases…";

  const { manifest, mapsData } = await buildDataset();
  state.manifest = manifest;
  state.mapsData = mapsData;
  els.buildInfo.textContent = `Loaded ${manifest.totalEvents.toLocaleString()} events across ${manifest.maps.length} maps`;
  els.loadingText.textContent = "Loading map…";

  populateModeSelect();
  populateMapSelect();
  resizeCanvas();

  if (els.mapSelect.value) {
    await loadMap(els.mapSelect.value);
  }

  els.loadingOverlay.classList.add("hidden");
}

init().catch(error => {
  console.error(error);
  els.buildInfo.textContent = `Failed to load telemetry data: ${error.message}`;
  els.loadingText.textContent = `Failed to load: ${error.message}`;
  els.loadingOverlay.classList.add("loading-error");
});