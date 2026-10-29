function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

function safeExternalUrl(value) {
    try {
        const url = new URL(String(value));
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return url.href;
        }
    } catch (e) {
        return '';
    }
    return '';
}

function externalLinkHtml(url, label) {
    const safeUrl = safeExternalUrl(url);
    if (!safeUrl) {
        return escapeHtml(label || url || '');
    }
    return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || safeUrl)}</a>`;
}

function linkifyPlainText(value) {
    const text = String(value ?? '');
    const urlRegex = /https?:\/\/[^\s<>"']+/gi;
    let html = '';
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

function computeSummary(data) {
    const playerNames = Object.keys(data || {});
    let scoreboardEntries = 0;
    let stillMia = 0;
    let playedAgain = 0;
    let totalKills = 0;

    playerNames.forEach(name => {
        const player = data[name] || {};
        const rows = player.scoreboard || [];
        scoreboardEntries += rows.length;
        totalKills += Number(player.kills_count || 0);
        rows.forEach(row => {
            if (row.StillPlaying) {
                playedAgain += 1;
            } else {
                stillMia += 1;
            }
        });
    });

    return { playerCount: playerNames.length, scoreboardEntries, stillMia, playedAgain, totalKills };
}

function renderSummary(data) {
    const summary = computeSummary(data);
    const container = document.getElementById('summary-container');
    container.textContent = [
        `${summary.playerCount} tracked accounts`,
        `${summary.scoreboardEntries.toLocaleString()} entries`,
        `${summary.stillMia.toLocaleString()} still MIA`,
        `${summary.playedAgain.toLocaleString()} played again`,
        `${summary.totalKills.toLocaleString()} kills`,
    ].join(' | ');
}

document.addEventListener("DOMContentLoaded", function () {
    fetch('combined_data.json')
        .then(response => response.json())
        .then(data => {
            createTabsAndTables(data);
            renderSummary(data);
        })
        .catch(error => console.error('Error loading JSON:', error));
});

// === EXISTING FUNCTION (unchanged) ===
function createTabsAndTables(data) {
    const tabsContainer = document.getElementById('tabs-container');
    const contentContainer = document.getElementById('content-container');
    const infoContainer = document.getElementById('info-container');

    let firstTab = true;

    for (const key in data) {
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.innerText = key;
        tabsContainer.appendChild(tab);

        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'table-wrapper';
        tableWrapper.style.display = firstTab ? 'block' : 'none';

        const table = document.createElement('table');
        table.id = key;
        table.classList.add('table-content');
        tableWrapper.appendChild(table);
        contentContainer.appendChild(tableWrapper);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'info-div';
        infoDiv.textContent = `Kills: ${data[key]["kills_count"]} ${data[key]["last_update"]}`;
        infoDiv.style.display = firstTab ? 'block' : 'none';
        infoContainer.appendChild(infoDiv);

        const rows = (data[key]["scoreboard"] || []).sort((a, b) => (b.break_taken || 0) - (a.break_taken || 0));
        createTable(table, rows);

        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.table-wrapper').forEach(w => w.style.display = 'none');
            document.querySelectorAll('.info-div').forEach(i => i.style.display = 'none');

            tab.classList.add('active');
            tableWrapper.style.display = 'block';
            infoDiv.style.display = 'block';
        });

        if (firstTab) {
            tab.classList.add('active');
            firstTab = false;
        }
    }
}

// Create a table from a JSON object
function createTable(table, data, headersOverride = null) {
    table.innerHTML = '';
    const thead = table.createTHead();
    const tbody = table.createTBody();
    const headers = headersOverride || Object.keys(data[0] || {});

    // Create table headers
    const row = thead.insertRow();

    // Add a header for the row number
    const thRowNum = document.createElement('th');
    thRowNum.innerText = '#'; // Header for row numbers
    row.appendChild(thRowNum);

    headers.forEach(header => {
        const th = document.createElement('th');
        // rename at creation time
        if (header === 'reports') th.innerText = 'source';
        else th.innerText = header;
        row.appendChild(th);
    });

    if (data.length === 0) {
        const emptyRow = tbody.insertRow();
        const emptyCell = emptyRow.insertCell();
        emptyCell.colSpan = Math.max(1, headers.length + 1);
        emptyCell.innerText = 'No entries';
        return;
    }

    // Create table rows
    data.forEach((item, index) => { // Use index to keep track of the row number
        const row = tbody.insertRow();

        // Highlight the row if StillPlaying is true
        if (item && item.StillPlaying === true) {
            row.classList.add('row-highlight');
        }

        // Insert row number as the first cell
        const cellRowNum = row.insertCell();
        cellRowNum.innerText = index + 1; // Display the row number (1-based index)

        headers.forEach(header => {
            const cell = row.insertCell();

            if (header === 'reports') {
                // item[header] may contain Twitch or YouTube links; show an appropriate label.
                const links = (item[header] || []).map(link => {
                    let displayText;
                    if (typeof link === 'string' && link.includes("twitch.tv")) {
                        displayText = "twitch";
                    } else if (typeof link === 'string' && link.includes("youtube.com")) {
                        displayText = "youtube";
                    } else {
                        displayText = link; 
                    }
                    return externalLinkHtml(link, displayText);
                }).join('<br>'); // Use <br> for line breaks

                cell.innerHTML = links; // clickable links
            } else {
                cell.innerText = item[header] !== undefined ? item[header] : '';
            }
        });
    });
}
