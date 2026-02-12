/**
 * LinkedIn Recruiter — Bell-Click Candidate Opener
 *
 * SIMPLIFIED TRIGGER: No automatic polling or badge detection.
 * When the user clicks the notification bell, we detect the dropdown
 * opening, extract candidate profile links ONLY FROM THE DROPDOWN,
 * dedup against history, and open new profiles for screening.
 *
 * IMPORTANT: This script only activates on the main recruiter/talent
 * pages — NOT on individual profile pages (those are handled by
 * profile-scraper.js). This prevents duplicate triggers from multiple tabs.
 */

(function () {
  "use strict";

  // ─── Guard: only run on top-level recruiter pages, NOT profile pages ──
  const url = window.location.href;
  if (
    url.includes("/profile/") ||
    url.includes("/in/") ||
    url.includes("/hire/")
  ) {
    console.log("[LNR] Skipping content.js on profile page:", url);
    return;
  }

  const CONFIG = {
    // Minimum time between tab-open batches (30 seconds)
    TAB_COOLDOWN_MS: 30000,
    // Debounce: wait this long after dropdown appears before extracting links
    DROPDOWN_DEBOUNCE_MS: 1500,
    // Notification text patterns to SKIP
    SKIP_PATTERNS: [
      "recommended match",
      "recommended for you",
      "suggested match",
      "job suggestion",
    ],
  };

  let lastTabOpenTime = 0;
  let dropdownDebounceTimer = null;
  let openedCandidateUrls = new Set();
  let isEnabled = true;
  // Prevent multiple triggers from the same bell click
  let lastBellClickTime = 0;

  /**
   * Check if a notification's surrounding text is a "Recommended matches"
   * type notification (not a real candidate alert).
   */
  function isSkippableNotification(linkElement) {
    const textToCheck = [];
    textToCheck.push((linkElement.textContent || "").toLowerCase());
    let parent = linkElement.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      textToCheck.push((parent.textContent || "").toLowerCase());
      parent = parent.parentElement;
    }
    const combined = textToCheck.join(" ");
    return CONFIG.SKIP_PATTERNS.some((pattern) => combined.includes(pattern));
  }

  /**
   * Find the visible notification dropdown container on the page.
   * Returns the dropdown element, or null if not found/not visible.
   */
  function findVisibleDropdown() {
    const DROPDOWN_SELECTORS = [
      '[class*="notification-dropdown"]',
      '[class*="notification-list"]',
      '[class*="notifications-dropdown"]',
      '[class*="notification-panel"]',
      '[class*="notifications-panel"]',
      '[class*="notification-content"]',
      '[class*="hp-notification"]',
      '[class*="notification-card"]',
      '[aria-label*="Notification"]',
      '[class*="notification"] [class*="dropdown"]',
      '[class*="notification"] [class*="panel"]',
      '[class*="notification"] [class*="list"]',
    ];

    for (const selector of DROPDOWN_SELECTORS) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (el.offsetParent !== null && el.querySelectorAll("a[href]").length > 0) {
          return el;
        }
      }
    }
    return null;
  }

  /**
   * Extracts candidate profile URLs ONLY from inside the notification dropdown.
   * Does NOT scan the whole page — this prevents picking up links from
   * profile pages, search results, sidebar recommendations, etc.
   */
  function extractCandidateLinks() {
    // First, find the dropdown container
    const dropdown = findVisibleDropdown();

    // Determine where to search for links
    let searchRoot;
    if (dropdown) {
      searchRoot = dropdown;
      console.log("[LNR] Extracting links from notification dropdown element.");
    } else {
      // Fallback: if we can't find a specific dropdown, search the page
      // but ONLY within notification-related containers
      console.log("[LNR] No dropdown found — searching notification containers only.");
      searchRoot = null;
    }

    const urls = [];
    const seen = new Set();

    // Get links from the dropdown (or notification containers)
    const links = searchRoot
      ? searchRoot.querySelectorAll("a[href]")
      : document.querySelectorAll(
          '[class*="notification"] a[href], [class*="alert"] a[href], [class*="update"] a[href]'
        );

    for (const link of links) {
      const href = link.href || "";
      // Must be a LinkedIn profile-type URL
      if (
        !href.includes("/profile/") &&
        !href.includes("/in/") &&
        !href.includes("/hire/") &&
        !href.includes("/talent/")
      )
        continue;
      // Skip navigation links
      if (
        href.includes("/settings") ||
        href.includes("/search?") ||
        href.includes("/reporting")
      )
        continue;

      const normalizedUrl = normalizeUrl(href);
      if (openedCandidateUrls.has(normalizedUrl)) continue;
      if (seen.has(normalizedUrl)) continue;
      if (isSkippableNotification(link)) continue;

      seen.add(normalizedUrl);
      urls.push(href);
    }

    console.log(`[LNR] extractCandidateLinks found ${urls.length} URL(s) (from ${searchRoot ? "dropdown" : "notification containers"})`);
    return urls;
  }

  /**
   * Normalize a URL for deduplication.
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
   * Send candidate URLs to background for tab opening.
   * Enforces cooldown and immediate dedup.
   */
  function sendCandidateUrls(urls) {
    if (!urls || urls.length === 0) {
      console.log("[LNR] No new candidate URLs found in dropdown.");
      return;
    }

    const now = Date.now();
    if (now - lastTabOpenTime < CONFIG.TAB_COOLDOWN_MS) {
      const remaining = Math.round((CONFIG.TAB_COOLDOWN_MS - (now - lastTabOpenTime)) / 1000);
      console.log(`[LNR] Cooldown active — skipping ${urls.length} URLs (${remaining}s remaining)`);
      return;
    }

    // Mark as opened BEFORE sending to background
    for (const url of urls) {
      openedCandidateUrls.add(normalizeUrl(url));
    }
    lastTabOpenTime = now;

    console.log(`[LNR] Sending ${urls.length} candidate URL(s) to background for tab opening.`);

    chrome.runtime.sendMessage({
      type: "CANDIDATE_LINKS_FOUND",
      candidateUrls: urls,
      timestamp: now,
    });
  }

  /**
   * Called when we detect the notification dropdown has appeared.
   */
  function onDropdownDetected() {
    if (!isEnabled) return;

    // Debounce to let dropdown finish rendering
    if (dropdownDebounceTimer) clearTimeout(dropdownDebounceTimer);
    dropdownDebounceTimer = setTimeout(() => {
      console.log("[LNR] Notification dropdown detected — extracting links...");
      const urls = extractCandidateLinks();
      sendCandidateUrls(urls);
    }, CONFIG.DROPDOWN_DEBOUNCE_MS);
  }

  // ─── Dropdown Detection ──────────────────────────────────────────

  function setupDropdownObserver() {
    const observer = new MutationObserver(() => {
      const dropdown = findVisibleDropdown();
      if (dropdown) {
        onDropdownDetected();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    console.log("[LNR] Dropdown observer active — waiting for bell click.");
  }

  // ─── Bell Click Interceptor ────────────────────────────────────────

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
      '[class*="notification"][class*="icon"]',
    ];

    document.addEventListener("click", (e) => {
      if (!isEnabled) return;

      // Prevent double-trigger: ignore clicks within 5 seconds of last bell click
      const now = Date.now();
      if (now - lastBellClickTime < 5000) return;

      for (const selector of BELL_SELECTORS) {
        const bellEl = e.target.closest(selector);
        if (bellEl) {
          lastBellClickTime = now;
          console.log("[LNR] Bell icon clicked — will extract links after dropdown loads.");
          setTimeout(() => {
            const urls = extractCandidateLinks();
            sendCandidateUrls(urls);
          }, 2000);
          return;
        }
      }
    }, true);

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
      console.log("[LNR] Bell/notification elements found:\n" + found.join("\n"));
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
  console.log("[LNR] Mode: BELL-CLICK — click the notification bell to scan profiles");
})();
