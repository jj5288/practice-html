/**
 * Background service worker for LinkedIn Recruiter Notification Detector.
 *
 * - Desktop notifications + badge updates
 * - Candidate screening via configurable LLM (fit score, salary, practice area, etc.)
 * - Legal recruiter detection + email alerts
 * - Google Sheets integration
 * - Recruiting analytics/intelligence
 */

// ─── LLM Model Presets ──────────────────────────────────────────────
// Add new models here — they'll appear in the Settings dropdown automatically.

const MODEL_PRESETS = {
  "kimi-k2.5": {
    label: "Kimi K2.5 (NVIDIA)",
    apiUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    modelId: "moonshotai/kimi-k2.5",
    provider: "nvidia",
  },
  "deepseek-r1": {
    label: "DeepSeek R1 (NVIDIA)",
    apiUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    modelId: "deepseek-ai/deepseek-r1",
    provider: "nvidia",
  },
  "llama-3.1-70b": {
    label: "Llama 3.1 70B (NVIDIA)",
    apiUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    modelId: "meta/llama-3.1-70b-instruct",
    provider: "nvidia",
  },
  "llama-3.1-405b": {
    label: "Llama 3.1 405B (NVIDIA)",
    apiUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    modelId: "meta/llama-3.1-405b-instruct",
    provider: "nvidia",
  },
  "mistral-large": {
    label: "Mistral Large (NVIDIA)",
    apiUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    modelId: "mistralai/mistral-large-2-instruct",
    provider: "nvidia",
  },
  "gpt-4o": {
    label: "GPT-4o (OpenAI)",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    modelId: "gpt-4o",
    provider: "openai",
  },
  "gpt-4o-mini": {
    label: "GPT-4o Mini (OpenAI)",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    modelId: "gpt-4o-mini",
    provider: "openai",
  },
  "claude-sonnet": {
    label: "Claude Sonnet 4.5 (Anthropic)",
    apiUrl: "https://api.anthropic.com/v1/messages",
    modelId: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
  },
  "custom": {
    label: "Custom Model",
    apiUrl: "",
    modelId: "",
    provider: "openai-compatible",
  },
};

const DEFAULT_SETTINGS = {
  enabled: true,
  desktopNotifications: true,
  autoOpenCandidates: true,
  autoScreenCandidates: true,
  acceptAll: false,        // When true, skip rejection rules — accept all candidates
  logRejected: true,       // When true, push rejected candidates to "Rejected" sheet tab
  maxProfilesToOpen: 10,   // Max tabs to open per bell-click (user adjustable, default 10)
  sheetsWebhookUrl: "",
  soundAlert: false,
  // LLM configuration
  llmPreset: "kimi-k2.5",
  llmApiKey: "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",
  llmCustomApiUrl: "",
  llmCustomModelId: "",
};

// Track state
let currentCount = 0;
let settings = { ...DEFAULT_SETTINGS };
let screeningQueue = [];
let isScreening = false;
// Track which tabs were auto-opened by the extension — PERSISTED to survive service worker restarts
let autoOpenedTabIds = new Set();
// Dedup: track URLs we've already opened (normalized) — persisted across restarts
let openedUrls = new Set();

// ─── Pipeline Diagnostics ─────────────────────────────────────────
// These counters help debug where the pipeline breaks.
const pipelineStats = {
  notificationsDetected: 0,
  candidateUrlsFound: 0,
  tabsOpened: 0,
  tabsOpenFailed: 0,
  scrapeChecks: 0,
  scrapeStarted: 0,
  scrapeCompleted: 0,
  llmCalls: 0,
  llmErrors: 0,
  llmFallbacks: 0,
  sheetsPushOk: 0,
  sheetsPushFail: 0,
};

// ─── Analytics Data Structure ───────────────────────────────────────

const DEFAULT_ANALYTICS = {
  totalAllTime: 0,
  notificationTimestamps: [],
  totalScreened: 0,
  totalQualified: 0,
  totalRejected: 0,
  totalRecruiters: 0,
  rejectionReasons: {},
  qualifiedCandidates: [],
  hourHistogram: new Array(24).fill(0),
  dayHistogram: new Array(7).fill(0),
  titleFrequency: {},
  locationFrequency: {},
  practiceAreaFrequency: {},
  firmTierFrequency: {},
  barAdmissionFrequency: {},
  // Compensation intelligence: salary estimates by practice area + city
  compensationData: [],
  // Candidate history for market movement detection
  candidateHistory: {},
};

let analytics = { ...DEFAULT_ANALYTICS };

// Load saved state on startup
chrome.storage.sync.get("settings", (result) => {
  if (result.settings) {
    settings = { ...DEFAULT_SETTINGS, ...result.settings };
  }
});

chrome.storage.local.get(["analytics", "openedUrls", "autoOpenedTabIds"], (result) => {
  if (result.analytics) {
    analytics = { ...DEFAULT_ANALYTICS, ...result.analytics };
    if (!Array.isArray(analytics.notificationTimestamps)) analytics.notificationTimestamps = [];
    if (!Array.isArray(analytics.qualifiedCandidates)) analytics.qualifiedCandidates = [];
    if (!Array.isArray(analytics.hourHistogram) || analytics.hourHistogram.length !== 24) {
      analytics.hourHistogram = new Array(24).fill(0);
    }
    if (!Array.isArray(analytics.dayHistogram) || analytics.dayHistogram.length !== 7) {
      analytics.dayHistogram = new Array(7).fill(0);
    }
    if (!analytics.practiceAreaFrequency) analytics.practiceAreaFrequency = {};
    if (!analytics.totalRecruiters) analytics.totalRecruiters = 0;
    if (!analytics.compensationData) analytics.compensationData = [];
    if (!analytics.candidateHistory) analytics.candidateHistory = {};
  }
  // Restore persistent dedup set
  if (result.openedUrls && Array.isArray(result.openedUrls)) {
    openedUrls = new Set(result.openedUrls);
    console.log(`[LNR Background] Restored ${openedUrls.size} dedup URLs from storage.`);
  }
  // Restore auto-opened tab IDs (survives service worker restarts in MV3)
  if (result.autoOpenedTabIds && Array.isArray(result.autoOpenedTabIds)) {
    autoOpenedTabIds = new Set(result.autoOpenedTabIds);
    console.log(`[LNR Background] Restored ${autoOpenedTabIds.size} auto-opened tab IDs from storage.`);
    // Clean up: verify these tabs still exist
    chrome.tabs.query({}, (tabs) => {
      const existingIds = new Set(tabs.map((t) => t.id));
      let removed = 0;
      for (const id of autoOpenedTabIds) {
        if (!existingIds.has(id)) {
          autoOpenedTabIds.delete(id);
          removed++;
        }
      }
      if (removed > 0) {
        console.log(`[LNR Background] Cleaned up ${removed} stale auto-opened tab IDs.`);
        saveAutoOpenedTabIds();
      }
    });
  }
});

function saveAnalytics() {
  chrome.storage.local.set({ analytics });
}

function saveOpenedUrls() {
  // Keep last 5000 URLs max to avoid storage bloat
  const urls = [...openedUrls].slice(-5000);
  chrome.storage.local.set({ openedUrls: urls });
}

function saveAutoOpenedTabIds() {
  chrome.storage.local.set({ autoOpenedTabIds: [...autoOpenedTabIds] });
}

// ─── Message Handling ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CANDIDATE_LINKS_FOUND") {
    pushUrlsToSheet(message.candidateUrls, sender);
  }
  if (message.type === "PROFILE_SCRAPED") {
    handleProfileScraped(message, sender);
  }
  if (message.type === "CHECK_AUTO_OPENED" || message.type === "CHECK_SHOULD_SCRAPE") {
    // Profile scraper asks: "Should I scrape this page?"
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const isAutoOpened = tabId ? autoOpenedTabIds.has(tabId) : false;
    pipelineStats.scrapeChecks++;
    console.log(`[LNR Background] CHECK_SHOULD_SCRAPE for tab ${tabId}: autoOpened=${isAutoOpened}, autoScreen=${settings.autoScreenCandidates}`);
    sendResponse({
      autoOpened: isAutoOpened,
      autoScreenEnabled: settings.autoScreenCandidates,
    });
    return true;
  }
  if (message.type === "GET_SETTINGS") {
    sendResponse({ settings, currentCount });
    return true;
  }
  if (message.type === "GET_MODEL_PRESETS") {
    sendResponse({ presets: MODEL_PRESETS });
    return true;
  }
  if (message.type === "GET_PIPELINE_STATS") {
    sendResponse({ pipelineStats });
    return true;
  }
  if (message.type === "GET_ANALYTICS") {
    sendResponse({ analytics: computeAnalyticsSummary() });
    return true;
  }
  if (message.type === "RESET_ANALYTICS") {
    analytics = {
      ...DEFAULT_ANALYTICS,
      hourHistogram: new Array(24).fill(0),
      dayHistogram: new Array(7).fill(0),
    };
    saveAnalytics();
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "UPDATE_SETTINGS") {
    settings = { ...settings, ...message.settings };
    chrome.storage.sync.set({ settings });
    if ("enabled" in message.settings) {
      broadcastToContentScripts({
        type: "SET_ENABLED",
        enabled: message.settings.enabled,
      });
    }
  }
});

// ─── Analytics Computation ──────────────────────────────────────────

function computeAnalyticsSummary() {
  const now = Date.now();
  const oneWeek = 7 * 86400000;
  const oneMonth = 30 * 86400000;
  const oneYear = 365 * 86400000;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const timestamps = analytics.notificationTimestamps;
  const today = timestamps.filter((t) => t >= todayMs).length;
  const thisWeek = timestamps.filter((t) => now - t < oneWeek).length;
  const thisMonth = timestamps.filter((t) => now - t < oneMonth).length;
  const thisYear = timestamps.filter((t) => now - t < oneYear).length;

  let peakHour = 0, peakHourCount = 0;
  for (let h = 0; h < 24; h++) {
    if (analytics.hourHistogram[h] > peakHourCount) {
      peakHourCount = analytics.hourHistogram[h];
      peakHour = h;
    }
  }

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let peakDay = 0, peakDayCount = 0;
  for (let d = 0; d < 7; d++) {
    if (analytics.dayHistogram[d] > peakDayCount) {
      peakDayCount = analytics.dayHistogram[d];
      peakDay = d;
    }
  }

  const sortedTitles = Object.entries(analytics.titleFrequency).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sortedLocations = Object.entries(analytics.locationFrequency).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sortedRejections = Object.entries(analytics.rejectionReasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sortedPracticeAreas = Object.entries(analytics.practiceAreaFrequency || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const qualRate = analytics.totalScreened > 0
    ? Math.round((analytics.totalQualified / analytics.totalScreened) * 100)
    : 0;

  const responseTimes = analytics.qualifiedCandidates
    .map((c) => c.responseTimeMs).filter((t) => t > 0);
  const avgResponseMin = responseTimes.length > 0
    ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) / 60000)
    : 0;

  const sortedFirmTiers = Object.entries(analytics.firmTierFrequency || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sortedBarAdmissions = Object.entries(analytics.barAdmissionFrequency || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Build practice area demand heatmap: practice area × location matrix
  const practiceAreaDemand = buildPracticeAreaDemand();

  // Build compensation summary: avg salary by practice area
  const compensationSummary = buildCompensationSummary();

  return {
    totalAllTime: analytics.totalAllTime,
    today, thisWeek, thisMonth, thisYear,
    totalScreened: analytics.totalScreened,
    totalQualified: analytics.totalQualified,
    totalRejected: analytics.totalRejected,
    totalRecruiters: analytics.totalRecruiters || 0,
    qualificationRate: qualRate,
    peakHour: formatHour(peakHour), peakHourRaw: peakHour,
    peakDay: dayNames[peakDay], peakDayRaw: peakDay,
    avgResponseMin,
    trendingTitles: sortedTitles,
    topLocations: sortedLocations,
    topRejectionReasons: sortedRejections,
    topPracticeAreas: sortedPracticeAreas,
    topFirmTiers: sortedFirmTiers,
    topBarAdmissions: sortedBarAdmissions,
    practiceAreaDemand,
    compensationSummary,
    hourHistogram: analytics.hourHistogram,
    dayHistogram: analytics.dayHistogram,
  };
}

/**
 * Build practice area demand heatmap: which practice areas appear most
 * in which locations. Returns top combos as [{area, location, count}].
 */
function buildPracticeAreaDemand() {
  const combos = {};
  for (const candidate of (analytics.qualifiedCandidates || [])) {
    const loc = candidate.location || "Unknown";
    const titles = candidate.titles || "";
    // Use location as the axis — practice areas come from practiceAreaFrequency
    if (loc) {
      combos[loc] = (combos[loc] || 0) + 1;
    }
  }

  // Cross-reference: for each comp data point, track practice area + location
  const areaLocCombos = {};
  for (const entry of (analytics.compensationData || [])) {
    if (entry.practiceArea && entry.location) {
      const areas = entry.practiceArea.split(",").map((a) => a.trim());
      for (const area of areas) {
        if (!area || area === "Not specified") continue;
        const key = `${area}|||${entry.location}`;
        areaLocCombos[key] = (areaLocCombos[key] || 0) + 1;
      }
    }
  }

  // Also check qualified candidates for practice area data
  // (compensation data may be sparse, so build from all screening data)
  // Return top 10 combos
  return Object.entries(areaLocCombos)
    .map(([key, count]) => {
      const [area, location] = key.split("|||");
      return { area, location, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

/**
 * Build compensation summary: average salary ranges by practice area.
 * Parses salary strings like "$120,000 - $160,000" into numeric midpoints.
 */
function buildCompensationSummary() {
  const byArea = {};
  for (const entry of (analytics.compensationData || [])) {
    if (!entry.practiceArea || entry.practiceArea === "Not specified") continue;
    if (!entry.salary || entry.salary === "Not enough data") continue;

    const areas = entry.practiceArea.split(",").map((a) => a.trim());
    const mid = parseSalaryMidpoint(entry.salary);
    if (!mid) continue;

    for (const area of areas) {
      if (!area) continue;
      if (!byArea[area]) byArea[area] = { total: 0, count: 0, samples: [] };
      byArea[area].total += mid;
      byArea[area].count++;
      byArea[area].samples.push({ salary: entry.salary, location: entry.location, firmTier: entry.firmTier });
    }
  }

  return Object.entries(byArea)
    .map(([area, data]) => ({
      area,
      avgSalary: Math.round(data.total / data.count),
      sampleCount: data.count,
      topSample: data.samples[data.samples.length - 1], // most recent
    }))
    .sort((a, b) => b.avgSalary - a.avgSalary)
    .slice(0, 8);
}

function parseSalaryMidpoint(salaryStr) {
  const numbers = salaryStr.match(/[\d,]+/g);
  if (!numbers || numbers.length === 0) return null;
  const nums = numbers.map((n) => parseInt(n.replace(/,/g, ""), 10)).filter((n) => n > 10000);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  return Math.round((nums[0] + nums[1]) / 2);
}

function formatHour(h) {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

// ─── Notification Handling ──────────────────────────────────────────
// Notifications are now triggered by bell-click in content.js.
// The CANDIDATE_LINKS_FOUND message is the sole entry point.

/**
 * Normalize URL for deduplication — strip hash and query noise.
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/**
 * Pushes candidate profile URLs directly to Google Sheets.
 * No tabs opened — just URLs sent to the "New Leads" sheet tab.
 * Deduplicates against previously sent URLs.
 */
async function pushUrlsToSheet(urls, sender) {
  if (!urls || urls.length === 0) return;

  const webhookUrl = settings.sheetsWebhookUrl;
  if (!webhookUrl) {
    console.warn("[LNR Background] No Google Sheets webhook URL configured — cannot push URLs.");
    return;
  }

  // Filter out already-sent URLs (persistent across restarts)
  const newUrls = [];
  for (const url of urls) {
    const norm = normalizeUrl(url);
    if (!openedUrls.has(norm)) {
      openedUrls.add(norm);
      newUrls.push(url);
    }
  }
  saveOpenedUrls();

  if (newUrls.length === 0) {
    console.log("[LNR Background] All URLs already sent — skipping.");
    chrome.action.setBadgeText({ text: "0" });
    return;
  }

  // Track as notification events for analytics
  const now = new Date();
  analytics.totalAllTime += newUrls.length;
  for (let i = 0; i < newUrls.length; i++) {
    analytics.notificationTimestamps.push(now.getTime());
  }
  analytics.hourHistogram[now.getHours()] += newUrls.length;
  analytics.dayHistogram[now.getDay()] += newUrls.length;
  const twoYearsAgo = now.getTime() - 730 * 86400000;
  analytics.notificationTimestamps = analytics.notificationTimestamps.filter((t) => t > twoYearsAgo);
  saveAnalytics();

  pipelineStats.candidateUrlsFound += newUrls.length;

  // Update badge to show how many we're pushing
  chrome.action.setBadgeText({ text: String(newUrls.length) });
  chrome.action.setBadgeBackgroundColor({ color: "#4ecca3" });

  console.log(`[LNR Background] Pushing ${newUrls.length} URL(s) to Google Sheet...`);

  // Tell content script which URLs were processed
  if (sender && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, {
      type: "TABS_OPENED",
      urls: newUrls,
    }).catch(() => {});
  }

  // Send all URLs in one batch to the sheet
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_leads",
        urls: newUrls,
        timestamp: now.toISOString(),
      }),
    });

    if (!response.ok) {
      pipelineStats.sheetsPushFail++;
      const errBody = await response.text().catch(() => "");
      console.error(`[LNR Background] Leads push FAILED: ${response.status}`, errBody.substring(0, 300));
    } else {
      pipelineStats.sheetsPushOk++;
      const respText = await response.text().catch(() => "");
      console.log(`[LNR Background] Leads push SUCCESS — ${newUrls.length} URLs sent. Response: ${respText.substring(0, 200)}`);
    }
  } catch (err) {
    pipelineStats.sheetsPushFail++;
    console.error("[LNR Background] Leads push ERROR:", err.message);
  }

  if (settings.desktopNotifications) {
    chrome.notifications.create(`lnr-leads-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "New Leads Added",
      message: `${newUrls.length} new candidate URL(s) pushed to Google Sheets.`,
      priority: 1,
    });
  }
}

function broadcastToContentScripts(message) {
  chrome.tabs.query(
    { url: ["https://www.linkedin.com/recruiter/*", "https://www.linkedin.com/talent/*"] },
    (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, message);
      }
    }
  );
}

// Clean up auto-opened tab tracking when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (autoOpenedTabIds.has(tabId)) {
    autoOpenedTabIds.delete(tabId);
    saveAutoOpenedTabIds();
  }
});

// When an auto-opened tab finishes loading, send START_SCRAPE as a backup
// (in case the content script's CHECK_AUTO_OPENED message raced with tab creation)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && autoOpenedTabIds.has(tabId)) {
    console.log(`[LNR Background] Auto-opened tab ${tabId} loaded — sending START_SCRAPE.`);
    chrome.tabs.sendMessage(tabId, { type: "START_SCRAPE" }).catch(() => {
      // Content script may not be ready yet, that's OK — CHECK_AUTO_OPENED handles it
    });
  }
});

// ─── Candidate Screening Pipeline ───────────────────────────────────

function handleProfileScraped(message, sender) {
  pipelineStats.scrapeCompleted++;
  const p = message.profile || {};
  console.log(`[LNR Background] ══════════════════════════════════════`);
  console.log(`[LNR Background] PROFILE_SCRAPED #${pipelineStats.scrapeCompleted}`);
  console.log(`[LNR Background]   Name: "${p.name || "(empty)"}"`);
  console.log(`[LNR Background]   Headline: "${(p.headline || "(empty)").substring(0, 80)}"`);
  console.log(`[LNR Background]   Location: "${p.location || "(empty)"}"`);
  console.log(`[LNR Background]   Experience items: ${p.experience ? p.experience.length : 0}`);
  console.log(`[LNR Background]   RawText length: ${(p.rawText || "").length} chars`);
  console.log(`[LNR Background]   URL: ${message.url || "(none)"}`);
  console.log(`[LNR Background] ══════════════════════════════════════`);

  if (!settings.autoScreenCandidates) {
    console.log("[LNR Background] Auto-screen is OFF — skipping screening.");
    return;
  }

  if (!p.rawText || p.rawText.length < 30) {
    console.warn("[LNR Background] WARNING: Profile has very little text data — LLM may produce poor results.");
  }

  message.profile._scrapedAt = Date.now();
  screeningQueue.push(message.profile);
  processScreeningQueue();
}

async function processScreeningQueue() {
  if (isScreening || screeningQueue.length === 0) return;
  isScreening = true;

  while (screeningQueue.length > 0) {
    const profile = screeningQueue.shift();
    try {
      const result = await screenCandidate(profile);
      console.log("[LNR Detector] Screening result:", result);

      analytics.totalScreened++;

      // ─── Legal Recruiter Detection ────────────────────────────
      if (result.data.isRecruiter) {
        analytics.totalRecruiters = (analytics.totalRecruiters || 0) + 1;

        // Send email alert for recruiters — these are rare and critical
        await sendRecruiterEmailAlert(result.data);

        if (settings.desktopNotifications) {
          chrome.notifications.create(`lnr-recruiter-${Date.now()}`, {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "LEGAL RECRUITER DETECTED",
            message: `${result.data.firstName} ${result.data.lastName} — ${result.data.currentJob}. Email sent!`,
            priority: 2,
          });
        }

        saveAnalytics();
        continue; // Don't push recruiters to the candidate sheet
      }

      // In "accept all" mode, override rejection — treat everyone as qualified
      const isQualified = settings.acceptAll ? true : result.qualified;

      if (isQualified) {
        analytics.totalQualified++;

        const responseTimeMs = profile._scrapedAt ? Date.now() - profile._scrapedAt : 0;

        analytics.qualifiedCandidates.push({
          timestamp: Date.now(),
          firstName: result.data.firstName,
          lastName: result.data.lastName,
          location: result.data.currentLocation,
          titles: result.data.openToWorkTitles,
          responseTimeMs,
        });

        // Track title frequency
        if (result.data.openToWorkTitles && result.data.openToWorkTitles !== "Not specified") {
          for (const title of result.data.openToWorkTitles.split(",").map((t) => t.trim())) {
            if (title) analytics.titleFrequency[title] = (analytics.titleFrequency[title] || 0) + 1;
          }
        }

        // Track location frequency
        if (result.data.currentLocation) {
          analytics.locationFrequency[result.data.currentLocation] =
            (analytics.locationFrequency[result.data.currentLocation] || 0) + 1;
        }

        // Track practice area frequency
        if (result.data.practiceArea && result.data.practiceArea !== "Not specified") {
          for (const area of result.data.practiceArea.split(",").map((a) => a.trim())) {
            if (area) analytics.practiceAreaFrequency[area] = (analytics.practiceAreaFrequency[area] || 0) + 1;
          }
        }

        // Track firm tier frequency
        if (result.data.firmTier && result.data.firmTier !== "Unknown" && result.data.firmTier !== "Other") {
          if (!analytics.firmTierFrequency) analytics.firmTierFrequency = {};
          analytics.firmTierFrequency[result.data.firmTier] =
            (analytics.firmTierFrequency[result.data.firmTier] || 0) + 1;
        }

        // Track bar admissions frequency
        if (result.data.barAdmissions && result.data.barAdmissions !== "Not found") {
          if (!analytics.barAdmissionFrequency) analytics.barAdmissionFrequency = {};
          for (const state of result.data.barAdmissions.split(",").map((s) => s.trim())) {
            if (state) analytics.barAdmissionFrequency[state] = (analytics.barAdmissionFrequency[state] || 0) + 1;
          }
        }

        // Compensation intelligence: accumulate salary data points
        if (result.data.salaryEstimate && result.data.salaryEstimate !== "Not enough data") {
          if (!analytics.compensationData) analytics.compensationData = [];
          analytics.compensationData.push({
            practiceArea: result.data.practiceArea,
            location: result.data.currentLocation,
            salary: result.data.salaryEstimate,
            firmTier: result.data.firmTier,
            timestamp: Date.now(),
          });
          // Keep last 1000 data points
          if (analytics.compensationData.length > 1000) {
            analytics.compensationData = analytics.compensationData.slice(-1000);
          }
        }

        // Candidate history: track for market movement detection
        if (!analytics.candidateHistory) analytics.candidateHistory = {};
        const historyKey = `${result.data.firstName}_${result.data.lastName}_${result.data.currentLocation}`.toLowerCase();
        analytics.candidateHistory[historyKey] = {
          firstName: result.data.firstName,
          lastName: result.data.lastName,
          currentJob: result.data.currentJob,
          location: result.data.currentLocation,
          practiceArea: result.data.practiceArea,
          qualified: true,
          timestamp: Date.now(),
        };

        await pushToGoogleSheet(result.data);

        if (settings.desktopNotifications) {
          const moveTag = result.data.physicalMove ? " [RELOCATING]" : "";
          chrome.notifications.create(`lnr-qualified-${Date.now()}`, {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: `Qualified (${result.data.fitScore}/10)${moveTag}`,
            message: `${result.data.firstName} ${result.data.lastName} — ${result.data.currentJob}`,
            priority: 2,
          });
        }
      } else {
        analytics.totalRejected++;
        const category = categorizeRejection(result.reason);
        analytics.rejectionReasons[category] = (analytics.rejectionReasons[category] || 0) + 1;
        console.log(`[LNR Detector] Candidate rejected: ${result.reason}`);

        // Push rejected candidates to "Rejected" sheet tab if enabled
        if (settings.logRejected !== false) {
          await pushRejectedToSheet(result.data, result.reason);
        }
      }

      saveAnalytics();
    } catch (err) {
      console.error(`[LNR Background] ❌ SCREENING PIPELINE ERROR for "${profile.name || "unknown"}":`, err.message);
      console.error("[LNR Background] Full error:", err);
    }
  }

  isScreening = false;
  console.log("[LNR Background] Screening queue empty — pipeline idle.");
}

function categorizeRejection(reason) {
  const lower = (reason || "").toLowerCase();
  if (lower.includes("job hop") || lower.includes("jobs in") || lower.includes("positions in")) return "Job hopping";
  if (lower.includes("in-house") || lower.includes("inhouse") || lower.includes("internal")) {
    if (lower.includes("looking") || lower.includes("seeking") || lower.includes("open to")) return "Seeking in-house";
    return "In-house candidate";
  }
  if (lower.includes("graduat") || lower.includes("12 month") || lower.includes("experience")) return "Too recent graduate";
  if (lower.includes("us") || lower.includes("united states") || lower.includes("location") || lower.includes("based")) return "Not US-based";
  return "Other";
}

// ─── LLM Screening ─────────────────────────────────────────────────

/**
 * Get the active LLM configuration from settings + presets.
 */
function getLlmConfig() {
  const preset = MODEL_PRESETS[settings.llmPreset] || MODEL_PRESETS["kimi-k2.5"];
  const apiKey = settings.llmApiKey || "";

  if (settings.llmPreset === "custom") {
    return {
      apiUrl: settings.llmCustomApiUrl || "",
      modelId: settings.llmCustomModelId || "",
      provider: "openai-compatible",
      apiKey,
    };
  }

  return {
    apiUrl: preset.apiUrl,
    modelId: preset.modelId,
    provider: preset.provider,
    apiKey,
  };
}

/**
 * Screen a candidate with auto-fallback.
 * If the primary model fails, automatically retries with DeepSeek R1 (NVIDIA).
 */
async function screenCandidate(profile) {
  const prompt = buildScreeningPrompt(profile);
  const primaryLlm = getLlmConfig();

  if (!primaryLlm.apiKey) {
    throw new Error("No API key configured. Go to Settings > AI Model to add one.");
  }

  // Try primary model first
  try {
    pipelineStats.llmCalls++;
    console.log(`[LNR Background] Calling LLM: ${primaryLlm.modelId} ...`);
    const result = await callLlm(prompt, profile, primaryLlm);
    console.log(`[LNR Background] LLM response received. Qualified: ${result.qualified}, Fit: ${result.data.fitScore}`);
    return result;
  } catch (primaryError) {
    pipelineStats.llmErrors++;
    console.error(`[LNR Background] Primary LLM failed (${primaryLlm.modelId}):`, primaryError.message);

    // Auto-fallback to DeepSeek R1 if it's a different model
    const fallbackPreset = MODEL_PRESETS["deepseek-r1"];
    if (primaryLlm.modelId !== fallbackPreset.modelId) {
      console.log(`[LNR Background] Falling back to ${fallbackPreset.modelId}...`);
      pipelineStats.llmFallbacks++;
      try {
        pipelineStats.llmCalls++;
        const fallbackLlm = {
          apiUrl: fallbackPreset.apiUrl,
          modelId: fallbackPreset.modelId,
          provider: fallbackPreset.provider,
          apiKey: primaryLlm.apiKey, // Use same API key (NVIDIA key works for all NVIDIA models)
        };
        const result = await callLlm(prompt, profile, fallbackLlm);
        console.log(`[LNR Background] Fallback LLM succeeded. Qualified: ${result.qualified}, Fit: ${result.data.fitScore}`);
        return result;
      } catch (fallbackError) {
        pipelineStats.llmErrors++;
        console.error(`[LNR Background] Fallback LLM also failed:`, fallbackError.message);
        throw new Error(`Both primary (${primaryLlm.modelId}) and fallback (${fallbackPreset.modelId}) failed. Primary: ${primaryError.message}. Fallback: ${fallbackError.message}`);
      }
    }

    throw primaryError; // No fallback available (already using DeepSeek)
  }
}

/**
 * Call an LLM with the given config. Returns parsed screening response.
 */
async function callLlm(prompt, profile, llm) {
  if (llm.provider === "anthropic") {
    return callLlmAnthropic(prompt, profile, llm);
  }

  // OpenAI-compatible format (NVIDIA, OpenAI, OpenRouter, etc.)
  const response = await fetch(llm.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: llm.modelId,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
      temperature: 0.1,
      top_p: 1.0,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText} ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  if (!content) {
    throw new Error("Empty response from LLM");
  }
  return parseScreeningResponse(content, profile);
}

/**
 * Anthropic uses a different request/response format.
 */
async function callLlmAnthropic(prompt, profile, llm) {
  const response = await fetch(llm.apiUrl, {
    method: "POST",
    headers: {
      "x-api-key": llm.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: llm.modelId,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText} ${errText}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || "";
  return parseScreeningResponse(content, profile);
}

function buildScreeningPrompt(profile) {
  return `You are a legal recruiting assistant for Voll Recruiting. Analyze this LinkedIn candidate profile thoroughly.

FIRST: Determine if this person IS a legal recruiter (works in legal staffing, legal recruiting, legal talent acquisition). Recruiters are NOT candidates — they are potential partners/competitors. Flag them separately.

If they are NOT a recruiter, evaluate them as a candidate using these STRICT rules:
1. NO JOB HOPPING: Must NOT have 3 or more different employers within any 5-year period.
2. NO IN-HOUSE CANDIDATES: Must NOT currently work in-house at a corporation. They should work at a law firm, staffing agency, consulting firm, or similar.
3. NO CANDIDATES LOOKING FOR IN-HOUSE ROLES: If "open to work" preferences mention in-house roles, reject.
4. MINIMUM EXPERIENCE: Must be at least 12 months since their most recent graduation date.
5. US-BASED: Must be located in the United States.

ADDITIONAL ANALYSIS (provide for ALL candidates, even rejected):

- FIT SCORE: Rate 1-10 overall fit quality (10 = perfect candidate)
- SALARY RANGE: Estimate annual salary range in USD based on title + location + experience level
- PRACTICE AREA: Extract their legal specialty/practice area(s) (e.g., IP, Corporate, Litigation, Real Estate, Family Law, Immigration, Employment, Tax, Bankruptcy, etc.). If not in legal, say "Non-legal"
- READY TO MOVE: Assess likelihood they'll actually move (High/Medium/Low) based on signals like recent profile updates, "open to work" badge, multiple job titles listed, etc.
- PHYSICAL MOVE: Compare their current location to their preferred on-site location(s). If these are DIFFERENT cities/states, they are looking to physically relocate — flag as true.

- BAR ADMISSIONS: Extract any state bar admissions mentioned in the profile (e.g., "NY", "CA", "TX"). Look in certifications, licenses, education, or profile text for phrases like "admitted in", "bar admission", "licensed in", "member of the bar". Return as comma-separated state abbreviations.

- LATERAL MOVE ANALYSIS: Analyze their career trajectory through law firms:
  * firmTier: Classify their CURRENT firm as "BigLaw/AmLaw100", "MidLaw", "SmallFirm/Boutique", "Government", "In-House", or "Other"
  * careerTrajectory: Is their career path "Ascending" (moving to better/bigger firms), "Lateral" (similar tier), "Descending" (moving down), or "Mixed"?
  * totalFirms: How many different law firms have they worked at?
  * avgTenureYears: Average years at each employer (estimate)
  * trajectoryNote: Brief 1-sentence summary of their career path (e.g., "Started at boutique, moved to BigLaw, now at AmLaw 50 firm — strong upward trajectory")

- DATA CONFIDENCE: Rate 1-10 how confident you are in your analysis based on available data:
  * 9-10: Full profile with detailed experience, education, clear practice area
  * 6-8: Good profile but missing some details (dates, firm names unclear)
  * 3-5: Sparse profile, had to make assumptions
  * 1-2: Very little data, mostly guessing
  Also note what key data is missing.

PROFILE DATA:
- Name: ${profile.name}
- Headline: ${profile.headline}
- Location: ${profile.location}
- Current Job: ${profile.currentJob}
- Open to Work Info: ${profile.openToWork || "Not specified"}
- Experience: ${profile.experience?.join(" | ") || "Not available"}
- Education: ${profile.education?.join(" | ") || "Not available"}
- Full Profile Text:
${profile.rawText}

RESPOND WITH EXACTLY THIS JSON FORMAT AND NOTHING ELSE:
{
  "isRecruiter": true or false,
  "recruiterNote": "If recruiter: what firm they work at and their specialty. If not a recruiter: empty string",
  "qualified": true or false,
  "reason": "Brief explanation of why they passed or failed the 5 rules",
  "fitScore": 1-10,
  "firstName": "extracted first name",
  "lastName": "extracted last name",
  "currentJob": "their current job title and company",
  "currentLocation": "their current city/state",
  "openToWorkTitles": "comma-separated job titles they are open to, or 'Not specified'",
  "onSiteLocationPreferred": "preferred on-site work location(s), or 'Not specified'",
  "practiceArea": "comma-separated legal practice areas, or 'Non-legal' or 'Not specified'",
  "salaryEstimate": "e.g. '$120,000 - $160,000' or 'Not enough data'",
  "readyToMove": "High, Medium, or Low",
  "physicalMove": true or false,
  "physicalMoveNote": "e.g. 'Currently in Chicago, looking for NYC roles' or empty string",
  "barAdmissions": "comma-separated state abbreviations, e.g. 'NY, CA, TX' or 'Not found'",
  "firmTier": "BigLaw/AmLaw100, MidLaw, SmallFirm/Boutique, Government, In-House, or Other",
  "careerTrajectory": "Ascending, Lateral, Descending, or Mixed",
  "totalFirms": number,
  "avgTenureYears": number,
  "trajectoryNote": "1-sentence career path summary",
  "dataConfidence": 1-10,
  "dataConfidenceNote": "What data is missing or uncertain"
}`;
}

function parseScreeningResponse(content, profile) {
  console.log(`[LNR Background] LLM raw response (first 500 chars): ${content.substring(0, 500)}`);
  try {
    let jsonStr = content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);
    console.log(`[LNR Background] Parsed LLM JSON — qualified: ${parsed.qualified}, fitScore: ${parsed.fitScore}, name: ${parsed.firstName} ${parsed.lastName}`);

    return {
      qualified: parsed.qualified === true,
      reason: parsed.reason || "No reason provided",
      data: {
        isRecruiter: parsed.isRecruiter === true,
        recruiterNote: parsed.recruiterNote || "",
        fitScore: parsed.fitScore || 0,
        firstName: parsed.firstName || "",
        lastName: parsed.lastName || "",
        currentJob: parsed.currentJob || "",
        currentLocation: parsed.currentLocation || "",
        profileUrl: profile.profileUrl || "",
        publicProfileUrl: profile.publicProfileUrl || "",
        openToWorkTitles: parsed.openToWorkTitles || "Not specified",
        onSiteLocationPreferred: parsed.onSiteLocationPreferred || "Not specified",
        practiceArea: parsed.practiceArea || "Not specified",
        salaryEstimate: parsed.salaryEstimate || "Not enough data",
        readyToMove: parsed.readyToMove || "Unknown",
        physicalMove: parsed.physicalMove === true,
        physicalMoveNote: parsed.physicalMoveNote || "",
        barAdmissions: parsed.barAdmissions || "Not found",
        firmTier: parsed.firmTier || "Unknown",
        careerTrajectory: parsed.careerTrajectory || "Unknown",
        totalFirms: parsed.totalFirms || 0,
        avgTenureYears: parsed.avgTenureYears || 0,
        trajectoryNote: parsed.trajectoryNote || "",
        dataConfidence: parsed.dataConfidence || 0,
        dataConfidenceNote: parsed.dataConfidenceNote || "",
      },
    };
  } catch (err) {
    console.error(`[LNR Background] ❌ FAILED to parse LLM response as JSON. Error: ${err.message}`);
    console.error(`[LNR Background] Full LLM response was:\n${content}`);
    return {
      qualified: false,
      reason: `Could not parse LLM screening response: ${err.message}`,
      data: {},
    };
  }
}

// ─── Legal Recruiter Email Alert ────────────────────────────────────
// Uses the same Google Apps Script webhook — it handles email sending
// server-side so we don't need extra permissions.

async function sendRecruiterEmailAlert(data) {
  const webhookUrl = settings.sheetsWebhookUrl;
  if (!webhookUrl) {
    console.warn("[LNR Detector] No webhook configured — cannot send recruiter email.");
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "recruiter_alert",
        firstName: data.firstName,
        lastName: data.lastName,
        currentJob: data.currentJob,
        currentLocation: data.currentLocation,
        profileUrl: data.profileUrl,
        publicProfileUrl: data.publicProfileUrl,
        recruiterNote: data.recruiterNote,
        timestamp: new Date().toISOString(),
      }),
    });
    console.log("[LNR Detector] Recruiter email alert sent.");
  } catch (err) {
    console.error("[LNR Detector] Failed to send recruiter email:", err);
  }
}

// ─── Google Sheets Integration ──────────────────────────────────────

async function pushToGoogleSheet(candidateData) {
  const webhookUrl = settings.sheetsWebhookUrl;
  if (!webhookUrl) {
    console.warn("[LNR Detector] No Google Sheets webhook URL configured.");
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "add_candidate",
      firstName: candidateData.firstName,
      lastName: candidateData.lastName,
      currentJob: candidateData.currentJob,
      currentLocation: candidateData.currentLocation,
      profileUrl: candidateData.profileUrl,
      openToWorkTitles: candidateData.openToWorkTitles,
      onSiteLocationPreferred: candidateData.onSiteLocationPreferred,
      fitScore: candidateData.fitScore,
      practiceArea: candidateData.practiceArea,
      salaryEstimate: candidateData.salaryEstimate,
      readyToMove: candidateData.readyToMove,
      physicalMove: candidateData.physicalMove ? "YES - RELOCATING" : "No",
      physicalMoveNote: candidateData.physicalMoveNote,
      publicProfileUrl: candidateData.publicProfileUrl,
      barAdmissions: candidateData.barAdmissions,
      firmTier: candidateData.firmTier,
      careerTrajectory: candidateData.careerTrajectory,
      totalFirms: candidateData.totalFirms,
      avgTenureYears: candidateData.avgTenureYears,
      trajectoryNote: candidateData.trajectoryNote,
      dataConfidence: candidateData.dataConfidence,
      dataConfidenceNote: candidateData.dataConfidenceNote,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    pipelineStats.sheetsPushFail++;
    const errBody = await response.text().catch(() => "");
    console.error(`[LNR Background] Sheets push FAILED (#${pipelineStats.sheetsPushFail}): ${response.status} ${response.statusText}`, errBody.substring(0, 300));
    throw new Error(`Sheets webhook error: ${response.status} ${errBody.substring(0, 100)}`);
  }

  pipelineStats.sheetsPushOk++;
  const respText = await response.text().catch(() => "");
  console.log(`[LNR Background] Sheets push SUCCESS (#${pipelineStats.sheetsPushOk}). Response: ${respText.substring(0, 200)}`);
}

async function pushRejectedToSheet(candidateData, reason) {
  const webhookUrl = settings.sheetsWebhookUrl;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_rejected",
        firstName: candidateData.firstName || "",
        lastName: candidateData.lastName || "",
        currentJob: candidateData.currentJob || "",
        currentLocation: candidateData.currentLocation || "",
        profileUrl: candidateData.profileUrl || "",
        publicProfileUrl: candidateData.publicProfileUrl || "",
        practiceArea: candidateData.practiceArea || "",
        onSiteLocationPreferred: candidateData.onSiteLocationPreferred || "",
        fitScore: candidateData.fitScore || 0,
        barAdmissions: candidateData.barAdmissions || "",
        firmTier: candidateData.firmTier || "",
        dataConfidence: candidateData.dataConfidence || 0,
        rejectionReason: reason || "Unknown",
        timestamp: new Date().toISOString(),
      }),
    });
    console.log("[LNR Detector] Rejected candidate logged to sheet.");
  } catch (err) {
    console.error("[LNR Detector] Failed to log rejected candidate:", err);
  }
}
