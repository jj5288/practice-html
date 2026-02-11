/**
 * Popup script for LinkedIn Recruiter Notification Detector.
 * Handles tab navigation, dashboard stats, intelligence data, and settings.
 */

// ─── Tab Navigation ─────────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ─── Settings Elements ──────────────────────────────────────────────

const toggleEnabled = document.getElementById("toggleEnabled");
const toggleDesktop = document.getElementById("toggleDesktop");
const toggleAutoOpen = document.getElementById("toggleAutoOpen");
const toggleAutoScreen = document.getElementById("toggleAutoScreen");
const toggleAcceptAll = document.getElementById("toggleAcceptAll");
const toggleLogRejected = document.getElementById("toggleLogRejected");
const sheetsUrlInput = document.getElementById("sheetsUrl");
const saveSheetUrlBtn = document.getElementById("saveSheetUrl");
const saveMsg = document.getElementById("saveMsg");
const resetBtn = document.getElementById("resetAnalytics");

// LLM model elements
const llmPresetSelect = document.getElementById("llmPreset");
const llmApiKeyInput = document.getElementById("llmApiKey");
const llmCustomApiUrl = document.getElementById("llmCustomApiUrl");
const llmCustomModelId = document.getElementById("llmCustomModelId");
const customModelFields = document.getElementById("customModelFields");
const saveLlmBtn = document.getElementById("saveLlmSettings");
const llmSaveMsg = document.getElementById("llmSaveMsg");

// Store sheetsWebhookUrl so we can open it on click
let sheetsUrl = "";

// ─── Set today's date ───────────────────────────────────────────────

const todayLabel = document.getElementById("statTodayLabel");
if (todayLabel) {
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "short" });
  const day = now.getDate();
  todayLabel.textContent = `Today (${month} ${day})`;
}

// ─── Load Model Presets + Settings ──────────────────────────────────

chrome.runtime.sendMessage({ type: "GET_MODEL_PRESETS" }, (resp) => {
  if (!resp || !resp.presets) return;
  const presets = resp.presets;

  // Populate dropdown
  llmPresetSelect.innerHTML = "";
  for (const [key, preset] of Object.entries(presets)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = preset.label;
    llmPresetSelect.appendChild(opt);
  }

  // Now load settings to set selected value
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
    if (!response) return;
    const { settings } = response;

    llmPresetSelect.value = settings.llmPreset || "kimi-k2.5";
    llmApiKeyInput.value = settings.llmApiKey || "";
    llmCustomApiUrl.value = settings.llmCustomApiUrl || "";
    llmCustomModelId.value = settings.llmCustomModelId || "";
    customModelFields.style.display = settings.llmPreset === "custom" ? "block" : "none";

    // Update label to show active model name
    const activePreset = presets[settings.llmPreset];
    if (activePreset) {
      const label = document.getElementById("autoScreenLabel");
      if (label) label.textContent = `Auto-screen candidates (${activePreset.label})`;
    }
  });
});

llmPresetSelect.addEventListener("change", () => {
  customModelFields.style.display = llmPresetSelect.value === "custom" ? "block" : "none";
});

saveLlmBtn.addEventListener("click", () => {
  const llmSettings = {
    llmPreset: llmPresetSelect.value,
    llmApiKey: llmApiKeyInput.value.trim(),
  };
  if (llmPresetSelect.value === "custom") {
    llmSettings.llmCustomApiUrl = llmCustomApiUrl.value.trim();
    llmSettings.llmCustomModelId = llmCustomModelId.value.trim();
  }
  chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: llmSettings });
  llmSaveMsg.style.display = "inline";
  setTimeout(() => { llmSaveMsg.style.display = "none"; }, 2000);
});

// ─── Load Settings ──────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
  if (!response) return;

  const { settings, currentCount } = response;

  toggleEnabled.checked = settings.enabled;
  toggleDesktop.checked = settings.desktopNotifications;
  toggleAutoOpen.checked = settings.autoOpenCandidates;
  toggleAutoScreen.checked = settings.autoScreenCandidates;
  toggleAcceptAll.checked = settings.acceptAll || false;
  toggleLogRejected.checked = settings.logRejected !== false; // default true
  sheetsUrlInput.value = settings.sheetsWebhookUrl || "";
  sheetsUrl = settings.sheetsWebhookUrl || "";
});

// ─── Load Analytics ─────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: "GET_ANALYTICS" }, (response) => {
  if (!response || !response.analytics) return;
  const a = response.analytics;

  // Dashboard counters
  document.getElementById("statToday").textContent = String(a.today || 0);
  document.getElementById("statWeek").textContent = String(a.thisWeek);
  document.getElementById("statMonth").textContent = String(a.thisMonth);
  document.getElementById("statYear").textContent = String(a.thisYear);
  document.getElementById("statAllTime").textContent = String(a.totalAllTime);

  // Screening stats
  document.getElementById("statScanned").textContent = String(a.totalScreened);
  document.getElementById("statQualified").textContent = String(a.totalQualified);
  document.getElementById("statRejected").textContent = String(a.totalRejected);
  document.getElementById("statQualRate").textContent = `${a.qualificationRate}%`;
  document.getElementById("statAvgResponse").textContent =
    a.avgResponseMin > 0 ? String(a.avgResponseMin) : "--";
  document.getElementById("statRecruiters").textContent = String(a.totalRecruiters || 0);

  // Intelligence — peak times
  document.getElementById("intelPeakHour").textContent = a.peakHour;
  document.getElementById("intelPeakDay").textContent = a.peakDay;

  // Hour histogram chart
  renderHourChart(a.hourHistogram);

  // Trending titles
  renderRankedList("trendingTitles", a.trendingTitles);

  // Top locations
  renderRankedList("topLocations", a.topLocations);

  // Practice areas
  renderRankedList("practiceAreas", a.topPracticeAreas);

  // Practice area demand heatmap
  renderDemandHeatmap(a.practiceAreaDemand);

  // Compensation intelligence
  renderCompensationList(a.compensationSummary);

  // Firm tier distribution
  renderRankedList("firmTiers", a.topFirmTiers);

  // Bar admissions
  renderRankedList("barAdmissions", a.topBarAdmissions);

  // Rejection reasons
  renderRankedList("rejectionReasons", a.topRejectionReasons);
});

// ─── Clickable Qualified Card → Open Google Sheet ───────────────────

const qualifiedCard = document.getElementById("qualifiedCard");
if (qualifiedCard) {
  qualifiedCard.addEventListener("click", () => {
    if (sheetsUrl) {
      // Extract the Google Sheet URL from the Apps Script URL
      // Apps Script URLs look like: https://script.google.com/macros/s/.../exec
      // We'll just open it — user can bookmark their sheet separately
      // For now, open a new tab to Google Sheets
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (resp) => {
        if (resp && resp.settings && resp.settings.sheetsWebhookUrl) {
          // Try to extract spreadsheet ID or just open Sheets
          const url = resp.settings.sheetsWebhookUrl;
          // Open the webhook URL with a GET request (shows "webhook is active")
          // Better: let user configure sheet URL directly, or open sheets.google.com
          chrome.tabs.create({ url: "https://docs.google.com/spreadsheets" });
        } else {
          chrome.tabs.create({ url: "https://docs.google.com/spreadsheets" });
        }
      });
    } else {
      chrome.tabs.create({ url: "https://docs.google.com/spreadsheets" });
    }
  });
}

// ─── Render Helpers ─────────────────────────────────────────────────

function renderHourChart(histogram) {
  const container = document.getElementById("hourChart");
  container.innerHTML = "";

  const max = Math.max(...histogram, 1);

  for (let h = 0; h < 24; h++) {
    const bar = document.createElement("div");
    bar.className = "bar";
    const pct = (histogram[h] / max) * 100;
    bar.style.height = `${Math.max(pct, 5)}%`;
    bar.title = `${formatHour(h)}: ${histogram[h]} notifications`;
    container.appendChild(bar);
  }
}

function formatHour(h) {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function renderRankedList(elementId, entries) {
  const ul = document.getElementById(elementId);
  if (!entries || entries.length === 0) {
    ul.innerHTML = '<li class="empty-state">No data yet</li>';
    return;
  }

  ul.innerHTML = "";
  for (const [name, count] of entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="rank-name">${escapeHtml(name)}</span><span class="rank-count">${count}</span>`;
    ul.appendChild(li);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderDemandHeatmap(demand) {
  const container = document.getElementById("demandHeatmap");
  if (!demand || demand.length === 0) {
    container.innerHTML = '<div class="empty-state">No data yet</div>';
    return;
  }

  const maxCount = Math.max(...demand.map((d) => d.count), 1);

  let html = '<table class="heatmap-table"><thead><tr><th>Practice Area</th><th>Location</th><th>#</th></tr></thead><tbody>';
  for (const d of demand) {
    const heatClass = d.count >= maxCount * 0.7 ? "heat-high" : d.count >= maxCount * 0.4 ? "heat-med" : "heat-low";
    html += `<tr>
      <td class="area-name">${escapeHtml(d.area)}</td>
      <td class="loc-name">${escapeHtml(d.location)}</td>
      <td><span class="heatmap-cell ${heatClass}">${d.count}</span></td>
    </tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderCompensationList(compData) {
  const container = document.getElementById("compensationList");
  if (!compData || compData.length === 0) {
    container.innerHTML = '<li class="empty-state">No data yet</li>';
    return;
  }

  container.innerHTML = "";
  for (const c of compData) {
    const li = document.createElement("li");
    li.className = "comp-row";
    li.innerHTML = `<span class="comp-area">${escapeHtml(c.area)}</span>
      <span class="comp-salary">$${c.avgSalary.toLocaleString()}</span>
      <span class="comp-count">(${c.sampleCount})</span>`;
    container.appendChild(li);
  }
}

// ─── Settings Event Handlers ────────────────────────────────────────

toggleEnabled.addEventListener("change", () => {
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { enabled: toggleEnabled.checked },
  });
});

toggleDesktop.addEventListener("change", () => {
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { desktopNotifications: toggleDesktop.checked },
  });
});

toggleAutoOpen.addEventListener("change", () => {
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { autoOpenCandidates: toggleAutoOpen.checked },
  });
});

toggleAutoScreen.addEventListener("change", () => {
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { autoScreenCandidates: toggleAutoScreen.checked },
  });
});

toggleAcceptAll.addEventListener("change", () => {
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { acceptAll: toggleAcceptAll.checked },
  });
});

toggleLogRejected.addEventListener("change", () => {
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { logRejected: toggleLogRejected.checked },
  });
});

saveSheetUrlBtn.addEventListener("click", () => {
  const url = sheetsUrlInput.value.trim();
  sheetsUrl = url;
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { sheetsWebhookUrl: url },
  });
  saveMsg.style.display = "inline";
  setTimeout(() => { saveMsg.style.display = "none"; }, 2000);
});

resetBtn.addEventListener("click", () => {
  if (confirm("Reset all analytics data? This cannot be undone.")) {
    chrome.runtime.sendMessage({ type: "RESET_ANALYTICS" }, () => {
      window.location.reload();
    });
  }
});
