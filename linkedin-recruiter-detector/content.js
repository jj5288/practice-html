/**
 * LinkedIn Recruiter Notification Detector
 *
 * Monitors the LinkedIn Recruiter page for red notification badges
 * and sends alerts via the Chrome extension messaging system.
 */

(function () {
  "use strict";

  const CONFIG = {
    POLL_INTERVAL_MS: 3000,
    // Selectors targeting the notification badge elements in LinkedIn Recruiter.
    // LinkedIn uses several patterns — we cast a wide net.
    BADGE_SELECTORS: [
      // Standard LinkedIn notification badge (red dot / count)
      ".notification-badge",
      ".notification-badge__count",
      '[data-test-notification-badge]',
      // Nav bar notification indicators
      ".nav-item__badge-count",
      ".global-nav__notification-badge",
      // Recruiter-specific badges
      ".recruiter-nav__badge",
      ".hp-nav__badge",
      ".hp-nav__badge-count",
      // Generic badge patterns used across LinkedIn
      '[class*="badge-count"]',
      '[class*="notification-count"]',
      // Bell icon badge specifically
      '.notification-bell .badge',
      '.notification-bell__badge',
      // Catch-all for elements with aria labels indicating counts
      '[aria-label*="notification"]',
    ],
  };

  let lastNotificationCount = 0;
  let isEnabled = true;
  // Track candidate URLs we've already opened to avoid duplicates
  let openedCandidateUrls = new Set();

  /**
   * Finds notification badge elements on the page and extracts the count.
   * Returns { found: boolean, count: number, element: Element|null }
   */
  function detectNotificationBadge() {
    for (const selector of CONFIG.BADGE_SELECTORS) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        // Check if the element is visible
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          continue;
        }

        // Try to extract a numeric count from the element
        const text = (el.textContent || "").trim();
        const count = parseInt(text, 10);

        if (count > 0) {
          return { found: true, count, element: el };
        }

        // Some badges are just a red dot with no number — check for
        // red-ish background color which indicates an active notification
        const bgColor = style.backgroundColor;
        if (isRedish(bgColor)) {
          return { found: true, count: 1, element: el };
        }
      }
    }

    // Fallback: scan for any small element with a red background that looks
    // like a notification dot (heuristic approach)
    return detectByColorHeuristic();
  }

  /**
   * Check if a CSS color string is "red-ish" (notification red).
   */
  function isRedish(colorStr) {
    if (!colorStr) return false;

    // Parse rgb/rgba
    const match = colorStr.match(
      /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/
    );
    if (!match) return false;

    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);

    // Red notification badges typically have high red, low green/blue
    return r > 180 && g < 80 && b < 80;
  }

  /**
   * Heuristic: look for small visible elements with red backgrounds
   * that are likely notification badges.
   */
  function detectByColorHeuristic() {
    // Look in the top navigation area (first 80px from top)
    const candidates = document.querySelectorAll(
      'nav *, header *, [role="navigation"] *, [class*="nav"] *'
    );

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      // Notification badges are small (typically < 30px)
      if (rect.width > 30 || rect.height > 30) continue;
      if (rect.width < 5 || rect.height < 5) continue;

      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;

      if (isRedish(style.backgroundColor)) {
        const text = (el.textContent || "").trim();
        const count = parseInt(text, 10);
        return {
          found: true,
          count: count > 0 ? count : 1,
          element: el,
        };
      }
    }

    return { found: false, count: 0, element: null };
  }

  /**
   * Extracts "View Candidate" profile URLs from the notification dropdown.
   * Looks for links with text like "View Candidate" and returns their hrefs.
   */
  function extractCandidateLinks() {
    const urls = [];

    // Strategy 1: Find links containing "View Candidate" text
    const allLinks = document.querySelectorAll("a");
    for (const link of allLinks) {
      const text = (link.textContent || "").trim();
      if (
        text.toLowerCase().includes("view candidate") &&
        link.href &&
        !openedCandidateUrls.has(link.href)
      ) {
        urls.push(link.href);
      }
    }

    // Strategy 2: Look inside notification list items for profile links
    const notifSelectors = [
      '[class*="notification"] a[href*="/profile/"]',
      '[class*="notification"] a[href*="/recruiter/"]',
      '[class*="notification"] a[href*="/talent/"]',
      '.notification-list a[href]',
      '[data-test-notification] a[href]',
    ];
    for (const selector of notifSelectors) {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        if (link.href && !openedCandidateUrls.has(link.href) && !urls.includes(link.href)) {
          urls.push(link.href);
        }
      }
    }

    return urls;
  }

  /**
   * Watches for the notification dropdown to appear in the DOM.
   * When it opens, scrape candidate links and send them to background.
   */
  function setupNotificationDropdownObserver() {
    const observer = new MutationObserver(() => {
      // Check if a notification dropdown/panel just appeared
      const dropdowns = document.querySelectorAll(
        '[class*="notification-dropdown"], [class*="notification-list"], [class*="notifications-dropdown"], [class*="notification-panel"], [aria-label*="Notification"]'
      );
      for (const dropdown of dropdowns) {
        if (dropdown.offsetParent !== null) {
          // Dropdown is visible — extract links
          const urls = extractCandidateLinks();
          if (urls.length > 0) {
            chrome.runtime.sendMessage({
              type: "CANDIDATE_LINKS_FOUND",
              candidateUrls: urls,
              timestamp: Date.now(),
            });
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Main polling loop. Checks for notification badges and notifies
   * the background script when changes are detected.
   */
  function poll() {
    if (!isEnabled) return;

    const result = detectNotificationBadge();

    if (result.found && result.count !== lastNotificationCount) {
      const isNewNotification = result.count > lastNotificationCount;
      lastNotificationCount = result.count;

      // Extract "View Candidate" links from the notification dropdown
      const candidateUrls = extractCandidateLinks();

      chrome.runtime.sendMessage({
        type: "NOTIFICATION_DETECTED",
        count: result.count,
        candidateUrls,
        isNewNotification,
        url: window.location.href,
        timestamp: Date.now(),
      });

      // Add a subtle visual indicator on the page
      showDetectionIndicator(result.count);
    } else if (!result.found && lastNotificationCount > 0) {
      // Notifications cleared
      lastNotificationCount = 0;
      chrome.runtime.sendMessage({
        type: "NOTIFICATIONS_CLEARED",
        url: window.location.href,
        timestamp: Date.now(),
      });
      removeDetectionIndicator();
    }
  }

  /**
   * Shows a small floating indicator that the extension detected notifications.
   */
  function showDetectionIndicator(count) {
    let indicator = document.getElementById("lnr-detector-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "lnr-detector-indicator";
      document.body.appendChild(indicator);
    }
    indicator.textContent = `🔔 ${count} new`;
    indicator.style.display = "block";
  }

  function removeDetectionIndicator() {
    const indicator = document.getElementById("lnr-detector-indicator");
    if (indicator) {
      indicator.style.display = "none";
    }
  }

  /**
   * Also observe DOM mutations so we catch dynamically loaded badges
   * without waiting for the next poll cycle.
   */
  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      // Only re-check if something in the nav/header area changed
      for (const mutation of mutations) {
        const target = mutation.target;
        if (
          target.closest &&
          (target.closest("nav") ||
            target.closest("header") ||
            target.closest('[role="navigation"]') ||
            target.closest('[class*="nav"]'))
        ) {
          poll();
          return;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-count"],
    });
  }

  // Listen for enable/disable messages from popup
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SET_ENABLED") {
      isEnabled = message.enabled;
      if (!isEnabled) {
        removeDetectionIndicator();
      }
    }
    if (message.type === "GET_STATUS") {
      chrome.runtime.sendMessage({
        type: "STATUS_RESPONSE",
        enabled: isEnabled,
        lastCount: lastNotificationCount,
        url: window.location.href,
      });
    }
    if (message.type === "TABS_OPENED") {
      // Track which URLs we already opened so we don't re-open them
      for (const url of message.urls) {
        openedCandidateUrls.add(url);
      }
    }
  });

  // Start detection
  setupMutationObserver();
  setupNotificationDropdownObserver();
  setInterval(poll, CONFIG.POLL_INTERVAL_MS);
  // Run immediately on load
  poll();

  console.log("[LinkedIn Recruiter Detector] Content script loaded.");
})();
