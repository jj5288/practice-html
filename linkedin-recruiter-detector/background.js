/**
 * Background service worker for LinkedIn Recruiter Notification Detector.
 *
 * Receives messages from the content script and triggers
 * desktop notifications + badge updates. Also handles candidate
 * screening via the Kimi K2.5 LLM, pushes qualified candidates
 * to Google Sheets, and tracks recruiting analytics/intelligence.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  desktopNotifications: true,
  autoOpenCandidates: true,
  autoScreenCandidates: true,
  sheetsWebhookUrl: "",
  soundAlert: false,
};

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_API_KEY =
  "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";

// Track state
let currentCount = 0;
let settings = { ...DEFAULT_SETTINGS };
let screeningQueue = [];
let isScreening = false;

// ─── Analytics Data Structure ───────────────────────────────────────
// Persisted in chrome.storage.local for durability across restarts.

const DEFAULT_ANALYTICS = {
  // Notification counters
  totalAllTime: 0,
  // Array of timestamps (ms) for every notification event
  notificationTimestamps: [],
  // Screening results
  totalScreened: 0,
  totalQualified: 0,
  totalRejected: 0,
  // Rejection reasons tally: { "Job hopping": 3, "Not US-based": 1, ... }
  rejectionReasons: {},
  // Qualified candidate data for intelligence
  // Each entry: { timestamp, firstName, lastName, location, titles, responseTimeMs }
  qualifiedCandidates: [],
  // Hour-of-day histogram (0-23) — when do notifications arrive?
  hourHistogram: new Array(24).fill(0),
  // Day-of-week histogram (0=Sun, 6=Sat)
  dayHistogram: new Array(7).fill(0),
  // Trending open-to-work titles: { "Legal Recruiter": 5, ... }
  titleFrequency: {},
  // Candidate locations: { "New York, NY": 8, ... }
  locationFrequency: {},
};

let analytics = { ...DEFAULT_ANALYTICS };

// Load saved state on startup
chrome.storage.sync.get("settings", (result) => {
  if (result.settings) {
    settings = { ...DEFAULT_SETTINGS, ...result.settings };
  }
});

chrome.storage.local.get("analytics", (result) => {
  if (result.analytics) {
    analytics = { ...DEFAULT_ANALYTICS, ...result.analytics };
    // Ensure arrays exist (storage can lose prototypes)
    if (!Array.isArray(analytics.notificationTimestamps)) {
      analytics.notificationTimestamps = [];
    }
    if (!Array.isArray(analytics.qualifiedCandidates)) {
      analytics.qualifiedCandidates = [];
    }
    if (!Array.isArray(analytics.hourHistogram) || analytics.hourHistogram.length !== 24) {
      analytics.hourHistogram = new Array(24).fill(0);
    }
    if (!Array.isArray(analytics.dayHistogram) || analytics.dayHistogram.length !== 7) {
      analytics.dayHistogram = new Array(7).fill(0);
    }
  }
});

function saveAnalytics() {
  chrome.storage.local.set({ analytics });
}

// ─── Message Handling ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "NOTIFICATION_DETECTED") {
    handleNotificationDetected(message, sender);
  }

  if (message.type === "NOTIFICATIONS_CLEARED") {
    handleNotificationsCleared();
  }

  if (message.type === "CANDIDATE_LINKS_FOUND") {
    openCandidateTabs(message.candidateUrls, sender);
  }

  if (message.type === "PROFILE_SCRAPED") {
    handleProfileScraped(message);
  }

  if (message.type === "GET_SETTINGS") {
    sendResponse({ settings, currentCount });
    return true;
  }

  if (message.type === "GET_ANALYTICS") {
    sendResponse({ analytics: computeAnalyticsSummary() });
    return true;
  }

  if (message.type === "RESET_ANALYTICS") {
    analytics = { ...DEFAULT_ANALYTICS, hourHistogram: new Array(24).fill(0), dayHistogram: new Array(7).fill(0) };
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
  const oneDay = 86400000;
  const oneWeek = 7 * oneDay;
  const oneMonth = 30 * oneDay;
  const oneYear = 365 * oneDay;

  const timestamps = analytics.notificationTimestamps;

  const thisWeek = timestamps.filter((t) => now - t < oneWeek).length;
  const thisMonth = timestamps.filter((t) => now - t < oneMonth).length;
  const thisYear = timestamps.filter((t) => now - t < oneYear).length;

  // Find peak hour (most notifications)
  let peakHour = 0;
  let peakHourCount = 0;
  for (let h = 0; h < 24; h++) {
    if (analytics.hourHistogram[h] > peakHourCount) {
      peakHourCount = analytics.hourHistogram[h];
      peakHour = h;
    }
  }

  // Find peak day
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let peakDay = 0;
  let peakDayCount = 0;
  for (let d = 0; d < 7; d++) {
    if (analytics.dayHistogram[d] > peakDayCount) {
      peakDayCount = analytics.dayHistogram[d];
      peakDay = d;
    }
  }

  // Top 5 trending titles
  const sortedTitles = Object.entries(analytics.titleFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Top 5 locations
  const sortedLocations = Object.entries(analytics.locationFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Top rejection reasons
  const sortedRejections = Object.entries(analytics.rejectionReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Qualification rate
  const qualRate =
    analytics.totalScreened > 0
      ? Math.round((analytics.totalQualified / analytics.totalScreened) * 100)
      : 0;

  // Average response time (time from notification to profile screened)
  const responseTimes = analytics.qualifiedCandidates
    .map((c) => c.responseTimeMs)
    .filter((t) => t > 0);
  const avgResponseMs =
    responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;
  const avgResponseMin = Math.round(avgResponseMs / 60000);

  return {
    // Counters
    totalAllTime: analytics.totalAllTime,
    thisWeek,
    thisMonth,
    thisYear,

    // Screening
    totalScreened: analytics.totalScreened,
    totalQualified: analytics.totalQualified,
    totalRejected: analytics.totalRejected,
    qualificationRate: qualRate,

    // Intelligence
    peakHour: formatHour(peakHour),
    peakHourRaw: peakHour,
    peakDay: dayNames[peakDay],
    peakDayRaw: peakDay,
    avgResponseMin,
    trendingTitles: sortedTitles,
    topLocations: sortedLocations,
    topRejectionReasons: sortedRejections,
    hourHistogram: analytics.hourHistogram,
    dayHistogram: analytics.dayHistogram,
  };
}

function formatHour(h) {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

// ─── Notification Handling ──────────────────────────────────────────

function handleNotificationDetected(message, sender) {
  const { count, candidateUrls, isNewNotification } = message;
  currentCount = count;

  chrome.action.setBadgeText({ text: String(count) });
  chrome.action.setBadgeBackgroundColor({ color: "#e94560" });

  // Track analytics for new notifications
  if (isNewNotification) {
    const now = new Date();
    const newCount = count - (analytics._lastCount || 0);
    const added = Math.max(newCount, 1);

    analytics.totalAllTime += added;
    for (let i = 0; i < added; i++) {
      analytics.notificationTimestamps.push(now.getTime());
    }
    analytics.hourHistogram[now.getHours()] += added;
    analytics.dayHistogram[now.getDay()] += added;
    analytics._lastCount = count;

    // Keep timestamps array from growing unbounded (keep last 2 years)
    const twoYearsAgo = now.getTime() - 730 * 86400000;
    analytics.notificationTimestamps = analytics.notificationTimestamps.filter(
      (t) => t > twoYearsAgo
    );

    saveAnalytics();
  }

  if (settings.desktopNotifications) {
    chrome.notifications.create(`lnr-notif-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "LinkedIn Recruiter",
      message: `You have ${count} new notification${count !== 1 ? "s" : ""} in LinkedIn Recruiter!`,
      priority: 2,
    });
  }

  if (isNewNotification && candidateUrls && candidateUrls.length > 0) {
    openCandidateTabs(candidateUrls, sender);
  }
}

function handleNotificationsCleared() {
  currentCount = 0;
  analytics._lastCount = 0;
  chrome.action.setBadgeText({ text: "" });
}

function openCandidateTabs(urls, sender) {
  if (!settings.autoOpenCandidates || !urls || urls.length === 0) return;

  const opened = [];
  for (const url of urls) {
    chrome.tabs.create({ url, active: false }, () => {
      opened.push(url);
      if (opened.length === urls.length && sender && sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: "TABS_OPENED",
          urls: opened,
        });
      }
    });
  }
}

function broadcastToContentScripts(message) {
  chrome.tabs.query(
    {
      url: [
        "https://www.linkedin.com/recruiter/*",
        "https://www.linkedin.com/talent/*",
      ],
    },
    (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, message);
      }
    }
  );
}

// ─── Candidate Screening Pipeline ───────────────────────────────────

function handleProfileScraped(message) {
  if (!settings.autoScreenCandidates) return;

  // Attach timestamp so we can compute response time later
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

      if (result.qualified) {
        analytics.totalQualified++;

        // Track intelligence data
        const responseTimeMs = profile._scrapedAt
          ? Date.now() - profile._scrapedAt
          : 0;

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
          const titles = result.data.openToWorkTitles.split(",").map((t) => t.trim());
          for (const title of titles) {
            if (title) {
              analytics.titleFrequency[title] = (analytics.titleFrequency[title] || 0) + 1;
            }
          }
        }

        // Track location frequency
        if (result.data.currentLocation) {
          const loc = result.data.currentLocation;
          analytics.locationFrequency[loc] = (analytics.locationFrequency[loc] || 0) + 1;
        }

        await pushToGoogleSheet(result.data);

        if (settings.desktopNotifications) {
          chrome.notifications.create(`lnr-qualified-${Date.now()}`, {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "Qualified Candidate Found",
            message: `${result.data.firstName} ${result.data.lastName} — ${result.data.currentJob}`,
            priority: 2,
          });
        }
      } else {
        analytics.totalRejected++;

        // Track rejection reason
        const reason = result.reason || "Unknown";
        // Categorize the reason into a short label
        const category = categorizeRejection(reason);
        analytics.rejectionReasons[category] =
          (analytics.rejectionReasons[category] || 0) + 1;

        console.log(`[LNR Detector] Candidate rejected: ${result.reason}`);
      }

      saveAnalytics();
    } catch (err) {
      console.error("[LNR Detector] Screening error:", err);
    }
  }

  isScreening = false;
}

/**
 * Categorizes a free-text rejection reason into a short label.
 */
function categorizeRejection(reason) {
  const lower = reason.toLowerCase();
  if (lower.includes("job hop") || lower.includes("jobs in") || lower.includes("positions in")) {
    return "Job hopping";
  }
  if (lower.includes("in-house") || lower.includes("inhouse") || lower.includes("internal")) {
    if (lower.includes("looking") || lower.includes("seeking") || lower.includes("open to")) {
      return "Seeking in-house";
    }
    return "In-house candidate";
  }
  if (lower.includes("graduat") || lower.includes("12 month") || lower.includes("experience")) {
    return "Too recent graduate";
  }
  if (lower.includes("us") || lower.includes("united states") || lower.includes("location") || lower.includes("based")) {
    return "Not US-based";
  }
  return "Other";
}

/**
 * Sends the candidate profile to Kimi K2.5 for screening.
 */
async function screenCandidate(profile) {
  const prompt = buildScreeningPrompt(profile);

  const response = await fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: "moonshotai/kimi-k2.5",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2048,
      temperature: 0.1,
      top_p: 1.0,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Kimi API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";

  return parseScreeningResponse(content, profile);
}

function buildScreeningPrompt(profile) {
  return `You are a recruiting assistant. Analyze this LinkedIn candidate profile and determine if they are a GOOD FIT based on these strict rules:

RULES:
1. NO JOB HOPPING: Must NOT have 3 or more different jobs within any 5-year period.
2. NO IN-HOUSE CANDIDATES: Candidate must NOT currently work in-house (i.e., they should work at a staffing agency, law firm, consulting firm, or similar — NOT as an internal/in-house employee at a non-recruiting/non-staffing company).
3. NO CANDIDATES LOOKING FOR IN-HOUSE ROLES: If their "open to work" preferences mention in-house roles, reject them.
4. MINIMUM EXPERIENCE: Must be at least 12 months since their most recent graduation date.
5. US-BASED: Candidate must be located in the United States.

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
  "qualified": true or false,
  "reason": "Brief explanation of why they passed or failed",
  "firstName": "extracted first name",
  "lastName": "extracted last name",
  "currentJob": "their current job title and company",
  "currentLocation": "their current city/state",
  "openToWorkTitles": "comma-separated list of job titles they are open to, or 'Not specified'",
  "onSiteLocationPreferred": "their preferred on-site work location(s), or 'Not specified'"
}`;
}

function parseScreeningResponse(content, profile) {
  try {
    let jsonStr = content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    return {
      qualified: parsed.qualified === true,
      reason: parsed.reason || "No reason provided",
      data: {
        firstName: parsed.firstName || "",
        lastName: parsed.lastName || "",
        currentJob: parsed.currentJob || "",
        currentLocation: parsed.currentLocation || "",
        profileUrl: profile.profileUrl || "",
        openToWorkTitles: parsed.openToWorkTitles || "Not specified",
        onSiteLocationPreferred:
          parsed.onSiteLocationPreferred || "Not specified",
      },
    };
  } catch (err) {
    console.error("[LNR Detector] Failed to parse LLM response:", content);
    return {
      qualified: false,
      reason: "Could not parse LLM screening response",
      data: {},
    };
  }
}

// ─── Google Sheets Integration ──────────────────────────────────────

async function pushToGoogleSheet(candidateData) {
  const webhookUrl = settings.sheetsWebhookUrl;
  if (!webhookUrl) {
    console.warn(
      "[LNR Detector] No Google Sheets webhook URL configured. Skipping push."
    );
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: candidateData.firstName,
      lastName: candidateData.lastName,
      currentJob: candidateData.currentJob,
      currentLocation: candidateData.currentLocation,
      profileUrl: candidateData.profileUrl,
      openToWorkTitles: candidateData.openToWorkTitles,
      onSiteLocationPreferred: candidateData.onSiteLocationPreferred,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Sheets webhook error: ${response.status}`);
  }

  console.log("[LNR Detector] Candidate pushed to Google Sheet.");
}
