/**
 * Background service worker for LinkedIn Recruiter Notification Detector.
 *
 * Receives messages from the content script and triggers
 * desktop notifications + badge updates.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  desktopNotifications: true,
  soundAlert: false,
};

// Track state
let currentCount = 0;
let settings = { ...DEFAULT_SETTINGS };

// Load saved settings on startup
chrome.storage.sync.get("settings", (result) => {
  if (result.settings) {
    settings = { ...DEFAULT_SETTINGS, ...result.settings };
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "NOTIFICATION_DETECTED") {
    handleNotificationDetected(message);
  }

  if (message.type === "NOTIFICATIONS_CLEARED") {
    handleNotificationsCleared();
  }

  if (message.type === "GET_SETTINGS") {
    sendResponse({ settings, currentCount });
    return true;
  }

  if (message.type === "UPDATE_SETTINGS") {
    settings = { ...settings, ...message.settings };
    chrome.storage.sync.set({ settings });

    // Forward enable/disable to content scripts
    if ("enabled" in message.settings) {
      broadcastToContentScripts({
        type: "SET_ENABLED",
        enabled: message.settings.enabled,
      });
    }
  }
});

function handleNotificationDetected(message) {
  const { count } = message;
  currentCount = count;

  // Update the extension badge
  chrome.action.setBadgeText({ text: String(count) });
  chrome.action.setBadgeBackgroundColor({ color: "#e94560" });

  // Send desktop notification if enabled
  if (settings.desktopNotifications) {
    chrome.notifications.create(`lnr-notif-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "LinkedIn Recruiter",
      message: `You have ${count} new notification${count !== 1 ? "s" : ""} in LinkedIn Recruiter!`,
      priority: 2,
    });
  }
}

function handleNotificationsCleared() {
  currentCount = 0;
  chrome.action.setBadgeText({ text: "" });
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
