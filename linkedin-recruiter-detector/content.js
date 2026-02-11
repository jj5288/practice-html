/**
 * LinkedIn Recruiter Notification Detector
 *
 * Monitors the LinkedIn Recruiter page for red notification badges
 * and sends alerts via the Chrome extension messaging system.
 */

(function () {
  "use strict";

  const CONFIG = {
    POLL_MIN_MS: 2500,
    POLL_MAX_MS: 5500,
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
  let pollCount = 0;
  // Track candidate URLs we've already opened to avoid duplicates
  let openedCandidateUrls = new Set();

  /**
   * Finds notification badge elements on the page and extracts the count.
   * Returns { found: boolean, count: number, element: Element|null }
   */
  function detectNotificationBadge() {
    const debugInfo = [];

    for (const selector of CONFIG.BADGE_SELECTORS) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        debugInfo.push(`${selector}: ${elements.length} match(es)`);
      }
      for (const el of elements) {
        // Check if the element is visible
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          debugInfo.push(`  ^ hidden (display:${style.display}, visibility:${style.visibility})`);
          continue;
        }

        // Try to extract a numeric count from the element
        const text = (el.textContent || "").trim();
        const count = parseInt(text, 10);

        if (count > 0) {
          console.log(`[LNR] FOUND badge via "${selector}" — count: ${count}, text: "${text}"`);
          return { found: true, count, element: el };
        }

        // Some badges are just a red dot with no number — check for
        // red-ish background color which indicates an active notification
        const bgColor = style.backgroundColor;
        if (isRedish(bgColor)) {
          console.log(`[LNR] FOUND red badge via "${selector}" — bg: ${bgColor}`);
          return { found: true, count: 1, element: el };
        }

        if (text) {
          debugInfo.push(`  ^ visible, text="${text}", bg=${bgColor}`);
        }
      }
    }

    // Log debug info every 20 polls so the console isn't flooded
    if (pollCount % 20 === 0 && debugInfo.length > 0) {
      console.log("[LNR] Selector scan results:\n" + debugInfo.join("\n"));
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
   * One-time page diagnostic — logs what the extension can see so we can
   * figure out the correct selectors if detection isn't working.
   */
  function runPageDiagnostic() {
    console.log("[LNR] ═══════════════════════════════════════════");
    console.log("[LNR] PAGE DIAGNOSTIC");
    console.log("[LNR] URL:", window.location.href);
    console.log("[LNR] Title:", document.title);

    // Check for nav/header elements
    const nav = document.querySelector("nav");
    const header = document.querySelector("header");
    console.log("[LNR] Has <nav>:", !!nav);
    console.log("[LNR] Has <header>:", !!header);

    // Look for anything bell/notification related
    const bellKeywords = ["bell", "notif", "badge", "alert", "inbox", "messaging"];
    const found = [];
    for (const kw of bellKeywords) {
      const matches = document.querySelectorAll(`[class*="${kw}"], [id*="${kw}"], [data-test*="${kw}"], [aria-label*="${kw}"]`);
      if (matches.length > 0) {
        for (const m of matches) {
          const tag = m.tagName.toLowerCase();
          const cls = (m.className || "").toString().substring(0, 100);
          const txt = (m.textContent || "").trim().substring(0, 50);
          const aria = m.getAttribute("aria-label") || "";
          found.push(`  [${kw}] <${tag}> class="${cls}" text="${txt}" aria="${aria}"`);
        }
      }
    }
    if (found.length > 0) {
      console.log("[LNR] Bell/notification elements found:\n" + found.join("\n"));
    } else {
      console.log("[LNR] WARNING: No bell/notification elements found on page!");
    }

    // Look for any element with red background in the nav area
    const navEl = nav || header || document.body;
    const redElements = [];
    const allNavChildren = navEl.querySelectorAll("*");
    for (const el of allNavChildren) {
      const style = window.getComputedStyle(el);
      if (isRedish(style.backgroundColor)) {
        const rect = el.getBoundingClientRect();
        redElements.push(`  <${el.tagName.toLowerCase()}> class="${(el.className || "").toString().substring(0, 80)}" size=${Math.round(rect.width)}x${Math.round(rect.height)} text="${(el.textContent || "").trim().substring(0, 30)}"`);
      }
    }
    if (redElements.length > 0) {
      console.log("[LNR] Red elements in nav/header:\n" + redElements.join("\n"));
    } else {
      console.log("[LNR] No red elements found in nav/header area.");
    }

    console.log("[LNR] ═══════════════════════════════════════════");
  }

  /**
   * Main polling loop. Checks for notification badges and notifies
   * the background script when changes are detected.
   */
  function poll() {
    if (!isEnabled) return;
    pollCount++;

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
   * Shows a persistent status indicator in the bottom-right corner
   * so you always know the extension is running.
   */
  function showStatusIndicator() {
    let status = document.getElementById("lnr-status-indicator");
    if (!status) {
      status = document.createElement("div");
      status.id = "lnr-status-indicator";
      document.body.appendChild(status);
    }
    status.textContent = "LNR Active — Scanning...";
    status.style.display = "block";
  }

  function updateStatusIndicator(text, color) {
    const status = document.getElementById("lnr-status-indicator");
    if (status) {
      status.textContent = text;
      if (color) status.style.borderColor = color;
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
    indicator.textContent = `New notifications: ${count}`;
    indicator.style.display = "block";
    updateStatusIndicator(`LNR Active — ${count} notification${count !== 1 ? "s" : ""} detected`, "#4ecca3");
  }

  function removeDetectionIndicator() {
    const indicator = document.getElementById("lnr-detector-indicator");
    if (indicator) {
      indicator.style.display = "none";
    }
    updateStatusIndicator(`LNR Active — Scanning... (${pollCount} checks)`, "#888");
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

  // Randomized delay helper — avoids fixed-interval fingerprinting
  function randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  }

  function schedulePoll() {
    setTimeout(() => {
      poll();
      schedulePoll();
    }, randomDelay(CONFIG.POLL_MIN_MS, CONFIG.POLL_MAX_MS));
  }

  // Start detection
  showStatusIndicator();
  runPageDiagnostic();
  setupMutationObserver();
  setupNotificationDropdownObserver();
  schedulePoll();
  // Run immediately on load
  poll();

  console.log("[LNR] Content script loaded and scanning on:", window.location.href);
})();
