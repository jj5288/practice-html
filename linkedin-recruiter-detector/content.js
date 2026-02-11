/**
 * LinkedIn Recruiter Notification Detector
 *
 * Monitors the LinkedIn Recruiter page for red notification badges
 * and sends alerts via the Chrome extension messaging system.
 *
 * SAFETY: Hard cap of 5 tabs per detection cycle. Immediate deduplication.
 * Throttled observers. Filters out "Recommended matches".
 */

(function () {
  "use strict";

  const CONFIG = {
    POLL_MIN_MS: 2500,
    POLL_MAX_MS: 5500,
    // Hard cap: never open more than this many tabs in a single cycle
    MAX_TABS_PER_CYCLE: 50,
    // Minimum time between tab-open batches (10 seconds)
    TAB_COOLDOWN_MS: 10000,
    // Minimum time between MutationObserver-triggered polls (5 seconds)
    OBSERVER_THROTTLE_MS: 5000,
    // Selectors targeting the notification badge elements in LinkedIn Recruiter.
    BADGE_SELECTORS: [
      ".notification-badge",
      ".notification-badge__count",
      '[data-test-notification-badge]',
      ".nav-item__badge-count",
      ".global-nav__notification-badge",
      ".recruiter-nav__badge",
      ".hp-nav__badge",
      ".hp-nav__badge-count",
      '[class*="badge-count"]',
      '[class*="notification-count"]',
      '.notification-bell .badge',
      '.notification-bell__badge',
      '[aria-label*="notification"]',
    ],
    // Notification text patterns to SKIP (not real candidate notifications)
    SKIP_PATTERNS: [
      "recommended match",
      "recommended for you",
      "suggested match",
      "job suggestion",
    ],
  };

  let lastNotificationCount = 0;
  let isEnabled = true;
  let pollCount = 0;
  let lastTabOpenTime = 0;
  let lastObserverPollTime = 0;
  // IMMEDIATE dedup: add URLs here BEFORE sending to background
  let openedCandidateUrls = new Set();

  /**
   * Finds notification badge elements on the page and extracts the count.
   */
  function detectNotificationBadge() {
    const debugInfo = [];

    for (const selector of CONFIG.BADGE_SELECTORS) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        debugInfo.push(`${selector}: ${elements.length} match(es)`);
      }
      for (const el of elements) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          debugInfo.push(`  ^ hidden (display:${style.display}, visibility:${style.visibility})`);
          continue;
        }

        const text = (el.textContent || "").trim();
        const count = parseInt(text, 10);

        if (count > 0) {
          console.log(`[LNR] FOUND badge via "${selector}" — count: ${count}, text: "${text}"`);
          return { found: true, count, element: el };
        }

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

    if (pollCount % 20 === 0 && debugInfo.length > 0) {
      console.log("[LNR] Selector scan results:\n" + debugInfo.join("\n"));
    }

    return detectByColorHeuristic();
  }

  function isRedish(colorStr) {
    if (!colorStr) return false;
    const match = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!match) return false;
    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);
    return r > 180 && g < 80 && b < 80;
  }

  function detectByColorHeuristic() {
    const candidates = document.querySelectorAll(
      'nav *, header *, [role="navigation"] *, [class*="nav"] *'
    );
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 30 || rect.height > 30) continue;
      if (rect.width < 5 || rect.height < 5) continue;

      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;

      if (isRedish(style.backgroundColor)) {
        const text = (el.textContent || "").trim();
        const count = parseInt(text, 10);
        return { found: true, count: count > 0 ? count : 1, element: el };
      }
    }
    return { found: false, count: 0, element: null };
  }

  /**
   * Check if a notification's surrounding text indicates it's a
   * "Recommended matches" type notification (not a real candidate alert).
   */
  function isSkippableNotification(linkElement) {
    // Check the link's own text and its parent notification item's text
    const textToCheck = [];
    textToCheck.push((linkElement.textContent || "").toLowerCase());

    // Walk up to 3 parents to find the notification container text
    let parent = linkElement.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      textToCheck.push((parent.textContent || "").toLowerCase());
      parent = parent.parentElement;
    }

    const combined = textToCheck.join(" ");
    return CONFIG.SKIP_PATTERNS.some((pattern) => combined.includes(pattern));
  }

  /**
   * Extracts candidate profile URLs from the notification dropdown.
   * Filters out "Recommended matches" and already-opened URLs.
   * Returns at most MAX_TABS_PER_CYCLE new URLs.
   */
  function extractCandidateLinks() {
    const urls = [];
    const seen = new Set();

    // Strategy 1: Find links containing "View Candidate" text
    const allLinks = document.querySelectorAll("a");
    for (const link of allLinks) {
      const text = (link.textContent || "").trim().toLowerCase();
      if (!text.includes("view candidate")) continue;
      if (!link.href) continue;

      // Normalize URL (strip hash/query variations for dedup)
      const normalizedUrl = normalizeUrl(link.href);
      if (openedCandidateUrls.has(normalizedUrl)) continue;
      if (seen.has(normalizedUrl)) continue;

      // Skip "Recommended matches" notifications
      if (isSkippableNotification(link)) {
        console.log("[LNR] Skipping recommended match:", link.href);
        continue;
      }

      seen.add(normalizedUrl);
      urls.push(link.href);

      if (urls.length >= CONFIG.MAX_TABS_PER_CYCLE) break;
    }

    // Strategy 2: Look inside notification items for profile links
    if (urls.length < CONFIG.MAX_TABS_PER_CYCLE) {
      const notifSelectors = [
        '[class*="notification"] a[href*="/profile/"]',
        '[class*="notification"] a[href*="/talent/"]',
      ];
      for (const selector of notifSelectors) {
        const links = document.querySelectorAll(selector);
        for (const link of links) {
          if (!link.href) continue;
          const normalizedUrl = normalizeUrl(link.href);
          if (openedCandidateUrls.has(normalizedUrl)) continue;
          if (seen.has(normalizedUrl)) continue;
          if (isSkippableNotification(link)) continue;

          seen.add(normalizedUrl);
          urls.push(link.href);

          if (urls.length >= CONFIG.MAX_TABS_PER_CYCLE) break;
        }
        if (urls.length >= CONFIG.MAX_TABS_PER_CYCLE) break;
      }
    }

    return urls;
  }

  /**
   * Normalize a URL for deduplication — strip hash and some query noise.
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
   * Safely send candidate URLs to background for tab opening.
   * Enforces cooldown and immediate dedup.
   */
  function sendCandidateUrls(urls) {
    if (!urls || urls.length === 0) return;

    const now = Date.now();
    if (now - lastTabOpenTime < CONFIG.TAB_COOLDOWN_MS) {
      console.log(`[LNR] Tab cooldown active — skipping ${urls.length} URLs (${Math.round((CONFIG.TAB_COOLDOWN_MS - (now - lastTabOpenTime)) / 1000)}s remaining)`);
      return;
    }

    // IMMEDIATELY mark these as opened BEFORE sending to background
    // This prevents re-sending on the next poll/observer cycle
    for (const url of urls) {
      openedCandidateUrls.add(normalizeUrl(url));
    }
    lastTabOpenTime = now;

    console.log(`[LNR] Opening ${urls.length} candidate tab(s) (max ${CONFIG.MAX_TABS_PER_CYCLE})`);

    chrome.runtime.sendMessage({
      type: "CANDIDATE_LINKS_FOUND",
      candidateUrls: urls,
      timestamp: now,
    });
  }

  /**
   * Watches for the notification dropdown to appear.
   * THROTTLED: won't re-fire within OBSERVER_THROTTLE_MS.
   */
  function setupNotificationDropdownObserver() {
    const observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastObserverPollTime < CONFIG.OBSERVER_THROTTLE_MS) return;

      const dropdowns = document.querySelectorAll(
        '[class*="notification-dropdown"], [class*="notification-list"], [class*="notifications-dropdown"], [class*="notification-panel"], [aria-label*="Notification"]'
      );
      for (const dropdown of dropdowns) {
        if (dropdown.offsetParent !== null) {
          lastObserverPollTime = now;
          const urls = extractCandidateLinks();
          sendCandidateUrls(urls);
          return; // Only process once per mutation batch
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * One-time page diagnostic.
   */
  function runPageDiagnostic() {
    console.log("[LNR] ═══════════════════════════════════════════");
    console.log("[LNR] PAGE DIAGNOSTIC");
    console.log("[LNR] URL:", window.location.href);
    console.log("[LNR] Title:", document.title);

    const nav = document.querySelector("nav");
    const header = document.querySelector("header");
    console.log("[LNR] Has <nav>:", !!nav);
    console.log("[LNR] Has <header>:", !!header);

    const bellKeywords = ["bell", "notif", "badge", "alert", "inbox", "messaging"];
    const found = [];
    for (const kw of bellKeywords) {
      const matches = document.querySelectorAll(`[class*="${kw}"], [id*="${kw}"], [data-test*="${kw}"], [aria-label*="${kw}"]`);
      for (const m of matches) {
        const tag = m.tagName.toLowerCase();
        const cls = (m.className || "").toString().substring(0, 100);
        const txt = (m.textContent || "").trim().substring(0, 50);
        const aria = m.getAttribute("aria-label") || "";
        found.push(`  [${kw}] <${tag}> class="${cls}" text="${txt}" aria="${aria}"`);
      }
    }
    if (found.length > 0) {
      console.log("[LNR] Bell/notification elements found:\n" + found.join("\n"));
    } else {
      console.log("[LNR] WARNING: No bell/notification elements found on page!");
    }

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
   * Main polling loop.
   */
  function poll() {
    if (!isEnabled) return;
    pollCount++;

    const result = detectNotificationBadge();

    if (result.found && result.count !== lastNotificationCount) {
      const isNewNotification = result.count > lastNotificationCount;
      lastNotificationCount = result.count;

      // Only extract and open links when the count INCREASES
      let candidateUrls = [];
      if (isNewNotification) {
        candidateUrls = extractCandidateLinks();
      }

      chrome.runtime.sendMessage({
        type: "NOTIFICATION_DETECTED",
        count: result.count,
        candidateUrls: [], // Don't send URLs here — use sendCandidateUrls instead
        isNewNotification,
        url: window.location.href,
        timestamp: Date.now(),
      });

      // Open tabs through the safe, throttled path
      if (isNewNotification && candidateUrls.length > 0) {
        sendCandidateUrls(candidateUrls);
      }

      showDetectionIndicator(result.count);
    } else if (!result.found && lastNotificationCount > 0) {
      lastNotificationCount = 0;
      chrome.runtime.sendMessage({
        type: "NOTIFICATIONS_CLEARED",
        url: window.location.href,
        timestamp: Date.now(),
      });
      removeDetectionIndicator();
    }
  }

  // ─── UI Indicators ────────────────────────────────────────────────

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

  // ─── MutationObserver (THROTTLED) ─────────────────────────────────

  function setupMutationObserver() {
    let throttleTimer = null;

    const observer = new MutationObserver((mutations) => {
      // Throttle: only allow one poll per OBSERVER_THROTTLE_MS
      if (throttleTimer) return;

      for (const mutation of mutations) {
        const target = mutation.target;
        if (
          target.closest &&
          (target.closest("nav") ||
            target.closest("header") ||
            target.closest('[role="navigation"]') ||
            target.closest('[class*="nav"]'))
        ) {
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
          }, CONFIG.OBSERVER_THROTTLE_MS);
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

  // ─── Message Handling ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SET_ENABLED") {
      isEnabled = message.enabled;
      if (!isEnabled) removeDetectionIndicator();
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
      for (const url of message.urls) {
        openedCandidateUrls.add(normalizeUrl(url));
      }
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────

  function randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  }

  function schedulePoll() {
    setTimeout(() => {
      poll();
      schedulePoll();
    }, randomDelay(CONFIG.POLL_MIN_MS, CONFIG.POLL_MAX_MS));
  }

  // ─── Start ────────────────────────────────────────────────────────
  showStatusIndicator();
  runPageDiagnostic();
  setupMutationObserver();
  setupNotificationDropdownObserver();
  schedulePoll();
  poll();

  console.log("[LNR] Content script loaded and scanning on:", window.location.href);
  console.log(`[LNR] Safety limits: max ${CONFIG.MAX_TABS_PER_CYCLE} tabs/cycle, ${CONFIG.TAB_COOLDOWN_MS / 1000}s cooldown between batches`);
})();
