/**
 * Popup script for LinkedIn Recruiter Notification Detector.
 */

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const countDisplay = document.getElementById("countDisplay");
const toggleEnabled = document.getElementById("toggleEnabled");
const toggleDesktop = document.getElementById("toggleDesktop");
const toggleAutoOpen = document.getElementById("toggleAutoOpen");
const toggleAutoScreen = document.getElementById("toggleAutoScreen");
const sheetsUrlInput = document.getElementById("sheetsUrl");
const saveSheetUrlBtn = document.getElementById("saveSheetUrl");
const saveMsg = document.getElementById("saveMsg");

// Load current state from background
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
  if (!response) {
    statusDot.classList.add("inactive");
    statusText.textContent = "No LinkedIn Recruiter tab open";
    countDisplay.textContent = "0";
    countDisplay.classList.add("zero");
    return;
  }

  const { settings, currentCount } = response;

  toggleEnabled.checked = settings.enabled;
  toggleDesktop.checked = settings.desktopNotifications;
  toggleAutoOpen.checked = settings.autoOpenCandidates;
  toggleAutoScreen.checked = settings.autoScreenCandidates;
  sheetsUrlInput.value = settings.sheetsWebhookUrl || "";

  if (settings.enabled) {
    statusDot.classList.add("active");
    statusText.textContent = "Monitoring active";
  } else {
    statusDot.classList.add("inactive");
    statusText.textContent = "Monitoring paused";
  }

  countDisplay.textContent = String(currentCount);
  if (currentCount === 0) {
    countDisplay.classList.add("zero");
  }
});

// Handle toggle changes
toggleEnabled.addEventListener("change", () => {
  const enabled = toggleEnabled.checked;
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { enabled },
  });

  if (enabled) {
    statusDot.className = "status-dot active";
    statusText.textContent = "Monitoring active";
  } else {
    statusDot.className = "status-dot inactive";
    statusText.textContent = "Monitoring paused";
  }
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

// Save Google Sheets webhook URL
saveSheetUrlBtn.addEventListener("click", () => {
  const url = sheetsUrlInput.value.trim();
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { sheetsWebhookUrl: url },
  });

  saveMsg.style.display = "inline";
  setTimeout(() => {
    saveMsg.style.display = "none";
  }, 2000);
});
