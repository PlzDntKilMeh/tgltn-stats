// Raw SQL table browser (Kills / Knocks), embedded in the "Browse Data"
// section of the map page. Loaded after map.js so it can reuse map.js's
// getTelemetryDb() — the exact same sql.js Database connection the map
// itself queries telemetry_index.sqlite3.gz through, rather than fetching
// and parsing its own separate copy of that file.

// damageTranslationDict / fetchTranslations() live in map.js (loaded before
// this file) since map.js's event stack now needs the same weapon-name
// lookup — both files just share the one global dictionary.

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.href;
    }
  } catch (e) {
    return "";
  }
  return "";
}

function externalLinkHtml(url, label) {
  const safeUrl = safeExternalUrl(url);
  if (!safeUrl) {
    return escapeHtml(label || url || "");
  }
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || safeUrl)}</a>`;
}

function linkifyPlainText(value) {
  const text = String(value ?? "");
  const urlRegex = /https?:\/\/[^\s<>"']+/gi;
  let html = "";
  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0];
    html += escapeHtml(text.slice(lastIndex, match.index));
    html += externalLinkHtml(url, url);
    lastIndex = match.index + url.length;
  }

  html += escapeHtml(text.slice(lastIndex));
  return html;
}

let dbInstance = null;
const sqlTableMetaCache = new Map();
const FILTER_DEBOUNCE_MS = 300;
const DAMAGE_TRANSLATION_COLS = new Set([
  "damageCauserName",
  "finishDamageInfo_damageCauserName",
  "killerDamageInfo_damageCauserName",
  "dBNODamageInfo_damageCauserName",
]);

function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function sqlNormalizedTextExpr(columnName) {
  let expr = `COALESCE(${quoteSqlIdentifier(columnName)}, '')`;
  expr = `REPLACE(${expr}, char(9), ' ')`;
  expr = `REPLACE(${expr}, char(10), ' ')`;
  expr = `REPLACE(${expr}, char(13), ' ')`;
  expr = `REPLACE(${expr}, char(160), ' ')`;
  expr = `REPLACE(${expr}, char(8203), '')`;
  expr = `REPLACE(${expr}, 'Р', 'P')`;
  expr = `REPLACE(${expr}, 'р', 'p')`;
  return expr;
}

function getColWidth(col) {
  if (col === "youtube_url") return "70px";
  if (col.includes("_json") || col.includes("AdditionalInfo")) return "200px";
  if (col.includes("name")) return "120px";
  if (col.startsWith("is") || col.includes("has_")) return "70px";
  return "100px";
}

async function createSqlTab(tabLabel, tableName) {
  const tabsContainer = document.getElementById("data-tabs-container");
  const contentContainer = document.getElementById("data-content-container");
  const infoContainer = document.getElementById("data-info-container");

  const tab = document.createElement("div");
  tab.className = "tab";
  tab.innerText = tabLabel;
  tabsContainer.appendChild(tab);

  const tableWrapper = document.createElement("div");
  tableWrapper.className = "telemetry-wrapper";
  tableWrapper.style.display = "none";
  contentContainer.appendChild(tableWrapper);

  const telemetryContent = document.createElement("div");
  telemetryContent.className = "telemetry-content";
  tableWrapper.appendChild(telemetryContent);

  const infoDiv = document.createElement("div");
  infoDiv.className = "info-div";
  infoDiv.innerHTML = `${tabLabel} data (<span id="db-status-${tableName}"></span>)`;
  infoDiv.style.display = "none";
  infoContainer.appendChild(infoDiv);

  tab.addEventListener("click", async () => {
    tabsContainer.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    contentContainer.querySelectorAll(".telemetry-wrapper").forEach(w => w.style.display = "none");
    infoContainer.querySelectorAll(".info-div").forEach(i => i.style.display = "none");

    tab.classList.add("active");
    tableWrapper.style.display = "block";
    infoDiv.style.display = "block";

    if (!dbInstance) {
      await loadSQLiteDatabase(infoDiv, tableName);
    }
    if (dbInstance && telemetryContent.dataset.renderedTable !== tableName) {
      renderSqlTable(telemetryContent, tableName);
      telemetryContent.dataset.renderedTable = tableName;
    }
  });

  return tab;
}

async function loadSQLiteDatabase(infoDiv, tableName) {
  const statusSpan = infoDiv.querySelector('span[id^="db-status"]');
  const loadingText = statusSpan || infoDiv;
  loadingText.innerHTML = '<strong style="color:#ffaa00">Loading DB...</strong>';

  try {
    // getTelemetryDb() (from map.js) is shared with the map view — reuses
    // its connection instead of independently fetching and parsing another
    // copy of the same telemetry_index.sqlite3.gz.
    dbInstance = await getTelemetryDb();
    loadingText.innerHTML = '<strong style="color:#00cc00">Loaded</strong>';
  } catch (err) {
    console.error(err);
    loadingText.innerHTML = '<strong style="color:#ff4444">Failed to load DB</strong>';
    alert("Could not load telemetry_index.sqlite3.gz\nMake sure the compressed file is in the repo root and deployed to GitHub Pages.");
  }
}

function getSqlTableMeta(tableName) {
  if (sqlTableMetaCache.has(tableName)) {
    return sqlTableMetaCache.get(tableName);
  }

  const quotedTable = quoteSqlIdentifier(tableName);
  const colResult = dbInstance.exec(`PRAGMA table_info(${quotedTable})`);
  const allColumns = colResult[0].values.map(row => row[1]);
  const rowLabels = ["Killer", "Victim"];
  if (tableName === "kill_v2_events") {
    rowLabels.push("Finisher", "dBNOMaker");
  }

  const suffixToCols = {};
  const otherCols = [];

  allColumns.forEach(col => {
    const lower = col.toLowerCase();
    let category = null;
    let suffix = col;

    if (lower.startsWith("killer_") || lower.startsWith("attacker_")) {
      category = "Killer";
      suffix = col.replace(/^(killer|attacker)_/i, "");
    } else if (lower.startsWith("victim_")) {
      category = "Victim";
      suffix = col.replace(/^victim_/i, "");
    } else if (lower.startsWith("finisher_") || lower.startsWith("finish_")) {
      category = "Finisher";
      suffix = col.replace(/^(finisher|finish)_/i, "");
    } else if (lower.startsWith("dbnomaker_")) {
      category = "dBNOMaker";
      suffix = col.replace(/^dbnomaker_/i, "");
    } else if (lower.includes("vehicle_")) {
      if (lower.startsWith("killer")) category = "Killer";
      else if (lower.startsWith("victim")) category = "Victim";
      suffix = col.split("_").slice(1).join("_");
    } else if (lower.includes("damageinfo_")) {
      if (lower.startsWith("killer")) category = "Killer";
      else if (lower.startsWith("finish")) category = "Finisher";
      else if (lower.startsWith("dbno")) category = "dBNOMaker";
      suffix = col.split("_").slice(1).join("_");
    } else if (tableName === "groggy_events") {
      const knownSuffixes = ["name", "accountId", "isInBlueZone", "isInRedZone", "isInVehicle", "zone_json", "damageReason", "damageCauserName", "distance", "isThroughPenetrableWall"];
      if (knownSuffixes.includes(col)) {
        category = "Killer";
        suffix = col;
      }
    }

    if (category) {
      if (!suffixToCols[suffix]) suffixToCols[suffix] = {};
      suffixToCols[suffix][category] = col;
    } else {
      otherCols.push(col);
    }
  });

  const orderedSuffixes = [
    "name", "accountId", "isInBlueZone", "isInRedZone", "isInVehicle", "zone_json",
    "vehicleId", "isWheelsInAir", "isInWaterVolume", "velocity",
    "damageReason", "damageCauserName", "distance", "isThroughPenetrableWall", "damageCauserAdditionalInfo_json",
  ].filter(s => suffixToCols[s]);

  Object.keys(suffixToCols).forEach(s => {
    if (!orderedSuffixes.includes(s)) orderedSuffixes.push(s);
  });

  const displayNames = {
    name: "Name", accountId: "ID", isInBlueZone: "inBlue", isInRedZone: "inRed", isInVehicle: "inCar", zone_json: "location",
    vehicleId: "CarName", isWheelsInAir: "CarInAir?", isInWaterVolume: "CarInWater?", velocity: "Speed",
    damageReason: "dmgReason", damageCauserName: "dmgCauser", distance: "Dist", isThroughPenetrableWall: "Wallbang", damageCauserAdditionalInfo_json: "attachments",
  };

  const meta = { allColumns, rowLabels, suffixToCols, otherCols, orderedSuffixes, displayNames };
  sqlTableMetaCache.set(tableName, meta);
  return meta;
}

function renderSqlTable(containerElement, tableName) {
  const PAGE_SIZE = 100;
  let currentFilters = {};
  let currentOffset = 0;
  let currentSort = "event_time";
  let sortDirection = "DESC";
  let showRowNumbers = false;
  let lastCountKey = null;
  let lastTotalMatching = 0;
  let filterDebounceTimer = null;
  let renderVersion = 0;

  let defaultVisibleColumns;
  if (tableName === "kill_v2_events") {
    defaultVisibleColumns = new Set(["youtube_url", "event_time", "killer_name", "victim_name", "finisher_name"]);
  }
  if (tableName === "groggy_events") {
    defaultVisibleColumns = new Set(["youtube_url", "event_time", "attacker_name", "victim_name"]);
  }
  const meta = getSqlTableMeta(tableName);
  const allColumns = meta.allColumns;
  const quotedTableName = quoteSqlIdentifier(tableName);

  renderCurrentPage(containerElement, PAGE_SIZE, currentFilters, currentOffset, defaultVisibleColumns);

  async function renderCurrentPage(container, limit, filters, offset, visibleColumns) {
    const thisRender = ++renderVersion;
    const focusedElement = document.activeElement;
    const focusedCol = focusedElement && focusedElement.classList.contains("column-filter") ? focusedElement.dataset.col : null;
    const cursorPos = focusedElement ? focusedElement.selectionStart : null;

    container.innerHTML = `<p style="padding:20px; color:#00cc00;">Loading data...</p>`;

    try {
      function buildFilterPredicate(col, filterValue) {
        const predicates = [`LOWER(${sqlNormalizedTextExpr(col)}) LIKE LOWER(?)`];
        const predicateParams = [`%${filterValue}%`];

        if (damageTranslationDict && DAMAGE_TRANSLATION_COLS.has(col)) {
          const needle = String(filterValue).toLowerCase();
          const matchingRawIds = [];

          for (const rawId in damageTranslationDict) {
            const friendly = damageTranslationDict[rawId];
            if (!friendly) continue;
            if (String(friendly).toLowerCase().includes(needle)) {
              matchingRawIds.push(rawId);
              if (matchingRawIds.length >= 200) break;
            }
          }

          if (matchingRawIds.length > 0) {
            predicates.push(`${quoteSqlIdentifier(col)} IN (${matchingRawIds.map(() => "?").join(",")})`);
            predicateParams.push(...matchingRawIds);
          }
        }

        return { sql: `(${predicates.join(" OR ")})`, params: predicateParams };
      }

      let whereClauses = [];
      let params = [];
      Object.keys(filters).forEach(col => {
        if (filters[col]) {
          const predicate = buildFilterPredicate(col, filters[col]);
          whereClauses.push(predicate.sql);
          params.push(...predicate.params);
        }
      });
      const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
      const countKey = JSON.stringify([whereSQL, params]);

      if (countKey !== lastCountKey) {
        const countResult = dbInstance.exec(`SELECT COUNT(*) FROM ${quotedTableName} ${whereSQL}`, params);
        lastTotalMatching = countResult[0].values[0][0];
        lastCountKey = countKey;
      }
      const totalMatching = lastTotalMatching;

      const orderSQL = currentSort ? `ORDER BY ${quoteSqlIdentifier(currentSort)} ${sortDirection}` : "";

      const selectedColumns = allColumns.filter(col => visibleColumns.has(col));
      const selectSQL = selectedColumns.length > 0
        ? selectedColumns.map(quoteSqlIdentifier).join(", ")
        : "NULL AS empty_result";
      const dataSQL = `SELECT ${selectSQL} FROM ${quotedTableName} ${whereSQL} ${orderSQL} LIMIT ${limit} OFFSET ${offset}`;
      const result = dbInstance.exec(dataSQL, params);
      const rows = result && result[0] ? result[0].values : [];
      const resultColumns = result && result[0] ? result[0].columns : selectedColumns;
      if (thisRender !== renderVersion) {
        return;
      }

      const hasPrevious = offset > 0;
      const hasMore = offset + rows.length < totalMatching;

      const { rowLabels, suffixToCols, otherCols, orderedSuffixes, displayNames } = meta;

      let columnSelectorHTML = `
        <div style="background:#1a1a1a; padding:3px 10px; border-radius:6px; margin-bottom:8px; border:1px solid #333;">
          <div style="display:flex; align-items:center; gap:12px; margin-bottom:4px; flex-wrap:wrap;">
            <strong style="font-size:0.8em;">Filters:</strong>
            <div style="display:flex; gap:3px;">
              <button class="show-all-btn" style="padding:0px 5px; font-size:0.75em; height:18px;">Show All</button>
              <button class="reset-cols-btn" style="padding:0px 5px; font-size:0.75em; height:18px;">Reset</button>
            </div>
            <label style="display:flex; align-items:center; gap:3px; font-size:0.75em; cursor:pointer; background:#333; padding:0px 5px; border-radius:3px; height:18px;">
              <input type="checkbox" id="toggle-row-nums" ${showRowNumbers ? "checked" : ""} style="transform: scale(0.7); margin:0;">
              Row#
            </label>
          </div>

          <div class="column-selector-wrapper" style="padding:5px; margin-bottom:5px;">
            <table class="column-selector-table">
              <thead>
                <tr>
                  <th style="position: sticky; left: 0; z-index: 3;">Category</th>
                  ${orderedSuffixes.map(s => `<th>${displayNames[s] || s}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
      `;

      rowLabels.forEach(cat => {
        columnSelectorHTML += `<tr><td class="category-label">${cat}</td>`;
        orderedSuffixes.forEach(s => {
          const colName = suffixToCols[s] ? suffixToCols[s][cat] : null;
          if (colName) {
            const isVisible = visibleColumns.has(colName);
            columnSelectorHTML += `
              <td>
                <input type="checkbox" class="col-toggle" data-col="${colName}" ${isVisible ? "checked" : ""} style="cursor:pointer; transform:scale(0.85);">
              </td>`;
          } else {
            columnSelectorHTML += `<td>-</td>`;
          }
        });
        columnSelectorHTML += `</tr>`;
      });

      columnSelectorHTML += `</tbody></table></div>`;

      if (otherCols.length > 0) {
        columnSelectorHTML += `<div class="other-cols-group" style="margin-top:0; padding-top:5px;">`;
        otherCols.forEach(col => {
          const isVisible = visibleColumns.has(col);
          columnSelectorHTML += `
            <label style="display:flex; align-items:center; gap:4px; font-size:0.75em; cursor:pointer; background:#222; padding:1px 6px; border-radius:3px;">
              <input type="checkbox" class="col-toggle" data-col="${col}" ${isVisible ? "checked" : ""} style="transform:scale(0.8);">
              ${col}
            </label>`;
        });
        columnSelectorHTML += `</div>`;
      }

      columnSelectorHTML += `</div>`;

      const rowNumStyle = showRowNumbers ? "" : "display:none;";
      let tableHTML = `
        <div style="max-height: 50vh; overflow: auto; border: 1px solid #333; border-radius: 6px;">
          <table class="sql-table">
            <thead>
              <tr>
                <th style="position: sticky; top: 0; left: 0; background: #1a1a1a; z-index: 20; width: 50px; min-width: 50px; ${rowNumStyle}">#</th>`;

      resultColumns.forEach(col => {
        const sortIcon = currentSort === col ? (sortDirection === "ASC" ? " ^" : " v") : "";
        const w = getColWidth(col);

        tableHTML += `
          <th class="sortable-header" data-col="${col}"
              style="position: sticky; top: 0; background: #1a1a1a; z-index: 10; cursor: pointer; user-select: none;
                     width: ${w}; min-width: ${w}; max-width: ${w};">
              ${escapeHtml(col)}${sortIcon}
          </th>`;
      });
      tableHTML += `</tr><tr>`;

      tableHTML += `<th style="position: sticky; top: 40px; left: 0; background: #1a1a1a; z-index: 20; ${rowNumStyle}"></th>`;
      resultColumns.forEach(col => {
        const val = filters[col] || "";
        const w = getColWidth(col);

        tableHTML += `
          <th style="position: sticky; top: 40px; background: #1a1a1a; z-index: 10;
                     width: ${w}; min-width: ${w}; max-width: ${w};">
            <input type="text" class="column-filter" placeholder="Filter ${escapeHtml(col)}" data-col="${escapeHtml(col)}"
                   value="${escapeHtml(val)}" style="width:100%; padding:2px; font-size:0.8em; border-radius:4px;">
          </th>`;
      });
      tableHTML += `</tr></thead><tbody>`;

      rows.forEach((rowData, idx) => {
        tableHTML += `<tr style="cursor:pointer;"><td style="position: sticky; left:0; background: #1a1a1a; z-index: 5; ${rowNumStyle}">${offset + idx + 1}</td>`;
        rowData.forEach((value, colIndex) => {
          const colName = resultColumns[colIndex];
          let display = (value === null || value === undefined) ? "" : String(value);

          if (colName === "youtube_url" && display) {
            display = externalLinkHtml(display, "youtube");
          } else {
            if (damageTranslationDict && DAMAGE_TRANSLATION_COLS.has(colName)) {
              const rawId = display;
              const friendly = damageTranslationDict[rawId];
              if (friendly && friendly !== rawId) {
                display = `${escapeHtml(rawId)} <span style="color:#888;">(${escapeHtml(friendly)})</span>`;
              } else {
                display = escapeHtml(rawId);
              }
            } else {
              display = linkifyPlainText(display);
            }
          }

          const w = getColWidth(colName);
          tableHTML += `
            <td style="width: ${w}; min-width: ${w}; max-width: ${w};">
              <div style="max-height: 50px; overflow-y: auto;">${display}</div>
            </td>`;
        });
        tableHTML += "</tr>";
      });
      tableHTML += "</tbody></table></div>";

      let paginationHTML = `
        <div style="margin-top: 20px; padding: 16px; background: #1a1a1a; border-radius: 6px;
                    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px;
                    position: sticky; bottom: 0; z-index: 100; border-top: 1px solid #333;">
          <div style="color: #ddd;">
            <strong>Matching rows:</strong> ${totalMatching.toLocaleString()}
            <span style="margin-left: 20px; color: #aaa;">
              Showing ${offset + 1} - ${Math.min(offset + rows.length, totalMatching)}
            </span>
          </div>
          <div style="display: flex; gap: 12px;">
            ${hasPrevious ? `<button id="prev-btn" class="pagination-btn">&lt; Previous ${PAGE_SIZE}</button>` : ""}
            ${hasMore ? `<button id="next-btn" class="pagination-btn">Next ${PAGE_SIZE} &gt;</button>` : ""}
          </div>
        </div>
      `;

      container.innerHTML = columnSelectorHTML + tableHTML + paginationHTML;

      if (focusedCol) {
        const input = container.querySelector(`.column-filter[data-col="${focusedCol}"]`);
        if (input) {
          input.focus();
          if (cursorPos !== null) input.setSelectionRange(cursorPos, cursorPos);
        }
      }

      const tableBody = container.querySelector(".sql-table tbody");
      if (tableBody) {
        tableBody.addEventListener("click", event => {
          const row = event.target.closest("tr");
          if (!row) return;
          tableBody.querySelectorAll("tr").forEach(r => r.classList.remove("selected"));
          row.classList.add("selected");
        });
      }

      container.querySelector("#toggle-row-nums").addEventListener("change", e => {
        showRowNumbers = e.target.checked;
        renderCurrentPage(container, limit, filters, offset, visibleColumns);
      });

      container.querySelector(".show-all-btn").addEventListener("click", () => {
        renderCurrentPage(container, limit, filters, offset, new Set(allColumns));
      });
      container.querySelector(".reset-cols-btn").addEventListener("click", () => {
        renderCurrentPage(container, limit, filters, offset, new Set(defaultVisibleColumns));
      });

      container.querySelectorAll(".sortable-header").forEach(header => {
        header.addEventListener("click", () => {
          const col = header.dataset.col;
          if (currentSort === col) {
            sortDirection = sortDirection === "ASC" ? "DESC" : "ASC";
          } else {
            currentSort = col;
            sortDirection = "ASC";
          }
          currentOffset = 0;
          renderCurrentPage(container, limit, filters, currentOffset, visibleColumns);
        });
      });

      container.querySelectorAll(".col-toggle").forEach(checkbox => {
        checkbox.addEventListener("change", () => {
          const col = checkbox.dataset.col;
          if (checkbox.checked) {
            visibleColumns.add(col);
          } else {
            visibleColumns.delete(col);
            delete filters[col];
          }
          renderCurrentPage(container, limit, filters, offset, visibleColumns);
        });
      });

      container.querySelectorAll(".column-filter").forEach(input => {
        input.addEventListener("input", () => {
          currentFilters[input.dataset.col] = input.value.trim();
          currentOffset = 0;
          clearTimeout(filterDebounceTimer);
          filterDebounceTimer = setTimeout(() => {
            renderCurrentPage(container, limit, currentFilters, currentOffset, visibleColumns);
          }, FILTER_DEBOUNCE_MS);
        });
      });

      const nextBtn = container.querySelector("#next-btn");
      if (nextBtn) nextBtn.addEventListener("click", () => {
        currentOffset += PAGE_SIZE;
        renderCurrentPage(container, limit, currentFilters, currentOffset, visibleColumns);
      });

      const prevBtn = container.querySelector("#prev-btn");
      if (prevBtn) prevBtn.addEventListener("click", () => {
        currentOffset = Math.max(0, currentOffset - PAGE_SIZE);
        renderCurrentPage(container, limit, currentFilters, currentOffset, visibleColumns);
      });
    } catch (e) {
      console.error(e);
      container.innerHTML = `<p style="padding:20px; color:#ff4444;">Error: ${e.message}</p>`;
    }
  }
}

createSqlTab("Kills", "kill_v2_events").then(killsTab => {
  // Auto-select Kills so opening the Browse Data section shows data
  // immediately, rather than requiring a further click to pick a table —
  // but only once Browse Data is actually opened, not eagerly here at page
  // load. Loading eagerly would fetch telemetry_index.sqlite3.gz a second
  // time in parallel with map.js's own fetch of that same file for the map
  // itself, doubling that download on every page load even for people who
  // never open Browse Data.
  const browseView = document.getElementById("browse-view");
  const browseBtn = document.getElementById("nav-browse-btn");
  const loadKillsOnce = () => {
    if (browseBtn) browseBtn.removeEventListener("click", loadKillsOnce);
    killsTab.click();
  };
  if (browseView && !browseView.classList.contains("hidden")) {
    // Already showing — e.g. index.html's "Browse data" link opens map.html
    // straight into this view (map.html#browse), so the click this would
    // otherwise wait for already happened before this script even loaded.
    loadKillsOnce();
  } else if (browseBtn) {
    browseBtn.addEventListener("click", loadKillsOnce);
  }
});

createSqlTab("Knocks", "groggy_events");
