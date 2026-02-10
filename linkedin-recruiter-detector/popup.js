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
const sheetsUrlInput = document.getElementById("sheetsUrl");
const saveSheetUrlBtn = document.getElementById("saveSheetUrl");
const saveMsg = document.getElementById("saveMsg");
const resetBtn = document.getElementById("resetAnalytics");

// ─── Load Settings ──────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
  if (!response) return;

  const { settings, currentCount } = response;

  toggleEnabled.checked = settings.enabled;
  toggleDesktop.checked = settings.desktopNotifications;
  toggleAutoOpen.checked = settings.autoOpenCandidates;
  toggleAutoScreen.checked = settings.autoScreenCandidates;
  sheetsUrlInput.value = settings.sheetsWebhookUrl || "";

  document.getElementById("statCurrent").textContent = String(currentCount);
});

// ─── Load Analytics ─────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: "GET_ANALYTICS" }, (response) => {
  if (!response || !response.analytics) return;
  const a = response.analytics;

  // Dashboard counters
  document.getElementById("statWeek").textContent = String(a.thisWeek);
  document.getElementById("statMonth").textContent = String(a.thisMonth);
  document.getElementById("statYear").textContent = String(a.thisYear);
  document.getElementById("statAllTime").textContent = String(a.totalAllTime);

  // Screening stats
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

  // Rejection reasons
  renderRankedList("rejectionReasons", a.topRejectionReasons);
});

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

saveSheetUrlBtn.addEventListener("click", () => {
  const url = sheetsUrlInput.value.trim();
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
      // Refresh the popup
      window.location.reload();
    });
  }
});
