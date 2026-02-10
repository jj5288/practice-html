/**
 * Background service worker for LinkedIn Recruiter Notification Detector.
 *
 * Receives messages from the content script and triggers
 * desktop notifications + badge updates. Also handles candidate
 * screening via the Kimi K2.5 LLM and pushes qualified candidates
 * to Google Sheets.
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
let screeningQueue = []; // profiles waiting to be screened
let isScreening = false;

// Load saved settings on startup
chrome.storage.sync.get("settings", (result) => {
  if (result.settings) {
    settings = { ...DEFAULT_SETTINGS, ...result.settings };
  }
});

// Listen for messages from content scripts
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

// ─── Notification Handling ───────────────────────────────────────────

function handleNotificationDetected(message, sender) {
  const { count, candidateUrls, isNewNotification } = message;
  currentCount = count;

  chrome.action.setBadgeText({ text: String(count) });
  chrome.action.setBadgeBackgroundColor({ color: "#e94560" });

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

      if (result.qualified) {
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
        console.log(
          `[LNR Detector] Candidate rejected: ${result.reason}`
        );
      }
    } catch (err) {
      console.error("[LNR Detector] Screening error:", err);
    }
  }

  isScreening = false;
}

/**
 * Sends the candidate profile to Kimi K2.5 for screening against
 * the recruiter's rules. Returns structured data if qualified.
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

/**
 * Parses the LLM response JSON. Falls back gracefully if the
 * response isn't perfectly formatted.
 */
function parseScreeningResponse(content, profile) {
  try {
    // Extract JSON from the response (handle markdown code blocks)
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

/**
 * Pushes a qualified candidate's data to Google Sheets via
 * a Google Apps Script web app webhook.
 */
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
