/**
 * LinkedIn Recruiter — Bell-Click Candidate Opener
 *
 * SIMPLIFIED TRIGGER: No automatic polling or badge detection.
 * When the user clicks the notification bell, we detect the dropdown
 * opening, extract all candidate profile links, dedup against history,
 * and open new profiles for screening (limit set in Settings).
 *
 * SAFETY: Tabs capped by user setting (default 10). Immediate deduplication.
 * Cooldown between batches. Filters out "Recommended matches".
 */

(function () {
  "use strict";

  const CONFIG = {
    // Hard cap: never open more than this many tabs in a single batch
    MAX_TABS_PER_BATCH: 50,
    // Minimum time between tab-open batches (10 seconds)
    TAB_COOLDOWN_MS: 10000,
    // Debounce: wait this long after dropdown appears before extracting links
    // (gives LinkedIn time to render all notification items)
    DROPDOWN_DEBOUNCE_MS: 1500,
    // Notification text patterns to SKIP (not real candidate notifications)
    SKIP_PATTERNS: [
      "recommended match",
      "recommended for you",
      "suggested match",
      "job suggestion",
    ],
  };

  let lastTabOpenTime = 0;
  let dropdownDebounceTimer = null;
  // IMMEDIATE dedup: add URLs here BEFORE sending to background
  let openedCandidateUrls = new Set();
  let isEnabled = true;

  /**
   * Check if a notification's surrounding text indicates it's a
   * "Recommended matches" type notification (not a real candidate alert).
   */
  function isSkippableNotification(linkElement) {
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
   * Returns at most MAX_TABS_PER_BATCH new URLs.
   */
  function extractCandidateLinks() {
    const urls = [];
    const seen = new Set();

    // Strategy 1: Find any links to candidate/profile pages on the page
    const allLinks = document.querySelectorAll("a[href]");
    for (const link of allLinks) {
      const href = link.href || "";
      // Must be a LinkedIn profile-type URL
      if (
        !href.includes("/profile/") &&
        !href.includes("/in/") &&
        !href.includes("/hire/") &&
        !href.includes("/talent/")
      )
        continue;
      // Skip navigation and non-candidate links
      if (
        href.includes("/settings") ||
        href.includes("/search?") ||
        href.includes("/reporting")
      )
        continue;

      const normalizedUrl = normalizeUrl(href);
      if (openedCandidateUrls.has(normalizedUrl)) continue;
      if (seen.has(normalizedUrl)) continue;

      // Skip "Recommended matches" notifications
      if (isSkippableNotification(link)) {
        console.log("[LNR] Skipping recommended match:", href);
        continue;
      }

      seen.add(normalizedUrl);
      urls.push(href);

      if (urls.length >= CONFIG.MAX_TABS_PER_BATCH) break;
    }

    // Strategy 2: Look inside notification items with broader selectors
    if (urls.length < CONFIG.MAX_TABS_PER_BATCH) {
      const notifSelectors = [
        '[class*="notification"] a[href*="/profile/"]',
        '[class*="notification"] a[href*="/talent/"]',
        '[class*="notification"] a[href*="/hire/"]',
        '[class*="notification"] a[href*="/in/"]',
        '[class*="alert"] a[href*="/profile/"]',
        '[class*="alert"] a[href*="/talent/"]',
        '[class*="update"] a[href*="/profile/"]',
        '[class*="update"] a[href*="/talent/"]',
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

          if (urls.length >= CONFIG.MAX_TABS_PER_BATCH) break;
        }
        if (urls.length >= CONFIG.MAX_TABS_PER_BATCH) break;
      }
    }

    console.log(`[LNR] extractCandidateLinks found ${urls.length} URL(s)`);
    return urls;
  }

  /**
   * Normalize a URL for deduplication — strip hash and query noise.
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
    if (!urls || urls.length === 0) {
      console.log("[LNR] No new candidate URLs found in dropdown.");
      return;
    }

    const now = Date.now();
    if (now - lastTabOpenTime < CONFIG.TAB_COOLDOWN_MS) {
      console.log(
        `[LNR] Tab cooldown active — skipping ${urls.length} URLs (${Math.round((CONFIG.TAB_COOLDOWN_MS - (now - lastTabOpenTime)) / 1000)}s remaining)`
      );
      return;
    }

    // IMMEDIATELY mark these as opened BEFORE sending to background
    for (const url of urls) {
      openedCandidateUrls.add(normalizeUrl(url));
    }
    lastTabOpenTime = now;

    console.log(
      `[LNR] Opening ${urls.length} candidate tab(s) (max ${CONFIG.MAX_TABS_PER_BATCH})`
    );

    chrome.runtime.sendMessage({
      type: "CANDIDATE_LINKS_FOUND",
      candidateUrls: urls,
      timestamp: now,
    });
  }

  /**
   * Called when we detect the notification dropdown has appeared.
   * Debounces to let LinkedIn finish rendering, then extracts links.
   */
  function onDropdownDetected() {
    if (!isEnabled) return;

    // Debounce: wait for dropdown to finish loading
    if (dropdownDebounceTimer) clearTimeout(dropdownDebounceTimer);
    dropdownDebounceTimer = setTimeout(() => {
      console.log("[LNR] Notification dropdown detected — extracting links...");
      const urls = extractCandidateLinks();
      sendCandidateUrls(urls);
    }, CONFIG.DROPDOWN_DEBOUNCE_MS);
  }

  // ─── Dropdown Detection ──────────────────────────────────────────

  /**
   * PRIMARY TRIGGER: Watches for the notification dropdown to appear.
   * This fires when the user clicks the bell icon.
   */
  function setupDropdownObserver() {
    // Broad selectors for notification dropdown/panel
    const DROPDOWN_SELECTORS = [
      '[class*="notification-dropdown"]',
      '[class*="notification-list"]',
      '[class*="notifications-dropdown"]',
      '[class*="notification-panel"]',
      '[class*="notifications-panel"]',
      '[class*="notification-content"]',
      '[aria-label*="Notification"]',
      '[class*="notification"] [class*="dropdown"]',
      '[class*="notification"] [class*="panel"]',
      '[class*="notification"] [class*="list"]',
      // LinkedIn Recruiter specific patterns
      '[class*="hp-notification"]',
      '[class*="notification-card"]',
    ];

    const observer = new MutationObserver((mutations) => {
      for (const selector of DROPDOWN_SELECTORS) {
        const dropdowns = document.querySelectorAll(selector);
        for (const dropdown of dropdowns) {
          if (dropdown.offsetParent !== null) {
            // Dropdown is visible — trigger extraction
            onDropdownDetected();
            return;
          }
        }
      }

      // Fallback: check if any mutation added a notification-like container
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node;
          const cls = (el.className || "").toString().toLowerCase();
          if (
            cls.includes("notification") ||
            cls.includes("dropdown") ||
            cls.includes("panel")
          ) {
            if (el.querySelectorAll('a[href*="/profile/"], a[href*="/in/"], a[href*="/talent/"], a[href*="/hire/"]').length > 0) {
              onDropdownDetected();
              return;
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    console.log("[LNR] Dropdown observer active — waiting for bell click.");
  }

  // ─── Bell Click Interceptor ────────────────────────────────────────

  /**
   * BACKUP TRIGGER: Also listen for clicks on the bell icon itself.
   * After a click, wait a moment for the dropdown to render, then extract.
   */
  function setupBellClickListener() {
    const BELL_SELECTORS = [
      '[class*="notification-bell"]',
      '[class*="notification"] button',
      '[class*="notification"] [role="button"]',
      '[aria-label*="notification" i]',
      '[aria-label*="Notification" i]',
      '[class*="bell"]',
      '[data-test*="notification"]',
      '[class*="hp-nav"] [class*="notification"]',
      '[class*="nav-item"] [class*="notification"]',
      // Generic: any small clickable element near notification badges
      '[class*="notification"][class*="icon"]',
    ];

    document.addEventListener("click", (e) => {
      if (!isEnabled) return;

      // Check if the click was on or inside a bell/notification element
      for (const selector of BELL_SELECTORS) {
        const bellEl = e.target.closest(selector);
        if (bellEl) {
          console.log("[LNR] Bell icon clicked — will extract links after dropdown loads.");
          // Wait for dropdown to render (longer than debounce since this is the initial trigger)
          setTimeout(() => {
            const urls = extractCandidateLinks();
            sendCandidateUrls(urls);
          }, 2000);
          return;
        }
      }
    }, true); // Use capture phase to catch it before LinkedIn's handlers

    console.log("[LNR] Bell click listener active.");
  }

  // ─── UI Indicator ──────────────────────────────────────────────────

  function showStatusIndicator() {
    let status = document.getElementById("lnr-status-indicator");
    if (!status) {
      status = document.createElement("div");
      status.id = "lnr-status-indicator";
      document.body.appendChild(status);
    }
    status.textContent = "LNR Active — Click bell to scan";
    status.style.display = "block";
  }

  // ─── Page Diagnostic ───────────────────────────────────────────────

  function runPageDiagnostic() {
    console.log("[LNR] ═══════════════════════════════════════════");
    console.log("[LNR] PAGE DIAGNOSTIC");
    console.log("[LNR] URL:", window.location.href);
    console.log("[LNR] Title:", document.title);

    const bellKeywords = ["bell", "notif", "badge", "alert", "inbox"];
    const found = [];
    for (const kw of bellKeywords) {
      const matches = document.querySelectorAll(
        `[class*="${kw}"], [id*="${kw}"], [data-test*="${kw}"], [aria-label*="${kw}"]`
      );
      for (const m of matches) {
        const tag = m.tagName.toLowerCase();
        const cls = (m.className || "").toString().substring(0, 100);
        const txt = (m.textContent || "").trim().substring(0, 50);
        const aria = m.getAttribute("aria-label") || "";
        found.push(
          `  [${kw}] <${tag}> class="${cls}" text="${txt}" aria="${aria}"`
        );
      }
    }
    if (found.length > 0) {
      console.log(
        "[LNR] Bell/notification elements found:\n" + found.join("\n")
      );
    } else {
      console.log("[LNR] WARNING: No bell/notification elements found on page!");
    }
    console.log("[LNR] ═══════════════════════════════════════════");
  }

  // ─── Message Handling ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SET_ENABLED") {
      isEnabled = message.enabled;
      const status = document.getElementById("lnr-status-indicator");
      if (status) {
        status.style.display = isEnabled ? "block" : "none";
      }
    }
    if (message.type === "TABS_OPENED") {
      for (const url of message.urls) {
        openedCandidateUrls.add(normalizeUrl(url));
      }
    }
  });

  // ─── Start ────────────────────────────────────────────────────────
  showStatusIndicator();
  runPageDiagnostic();
  setupDropdownObserver();
  setupBellClickListener();

  console.log("[LNR] Content script loaded on:", window.location.href);
  console.log(
    `[LNR] Mode: BELL-CLICK — click the notification bell to scan up to ${CONFIG.MAX_TABS_PER_BATCH} profiles`
  );
})();
