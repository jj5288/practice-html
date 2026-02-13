/**
 * LinkedIn Recruiter — Bell-Hover Candidate Opener
 *
 * TRIGGER: When the user hovers over the notification bell, LinkedIn
 * renders a dropdown with notification items. We detect this by watching
 * for NEW DOM nodes that contain profile links — no CSS class name
 * guessing needed. Works regardless of LinkedIn's internal class names.
 *
 * Only runs on main recruiter/talent pages, NOT individual profile pages.
 */

(function () {
  "use strict";

  // ─── Guard: only run on main recruiter/talent pages with the bell ───
  const path = new URL(window.location.href).pathname;
  const ALLOWED_PAGES = [
    "/talent/home",
    "/talent/hire",
    "/recruiter/home",
    "/recruiter",
  ];
  const isAllowed = ALLOWED_PAGES.some((p) => path.startsWith(p));
  if (!isAllowed) {
    // Silent skip — don't log on every profile page
    return;
  }

  const CONFIG = {
    // Cooldown between sends to background (30 seconds)
    COOLDOWN_MS: 30000,
    // After detecting new profile links, wait this long for more to load
    DEBOUNCE_MS: 2000,
    // Notification text patterns to SKIP
    SKIP_PATTERNS: [
      "recommended match",
      "recommended for you",
      "suggested match",
      "job suggestion",
    ],
  };

  let lastSendTime = 0;
  let debounceTimer = null;
  let openedCandidateUrls = new Set();
  let isEnabled = true;
  // Snapshot of profile link hrefs present on page load (to ignore static page links)
  let baselineLinks = new Set();
  let baselineTaken = false;

  // ─── Helpers ────────────────────────────────────────────────────────

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  function isProfileHref(href) {
    if (!href) return false;
    if (
      !href.includes("/profile/") &&
      !href.includes("/in/") &&
      !href.includes("/hire/") &&
      !href.includes("/talent/")
    ) return false;
    if (
      href.includes("/settings") ||
      href.includes("/search?") ||
      href.includes("/reporting")
    ) return false;
    return true;
  }

  function isSkippableNotification(linkElement) {
    const textToCheck = [];
    textToCheck.push((linkElement.textContent || "").toLowerCase());
    let parent = linkElement.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      textToCheck.push((parent.textContent || "").toLowerCase());
      parent = parent.parentElement;
    }
    const combined = textToCheck.join(" ");
    return CONFIG.SKIP_PATTERNS.some((p) => combined.includes(p));
  }

  // ─── Baseline snapshot ──────────────────────────────────────────────
  // Take a snapshot of all profile links already on the page.
  // Any NEW profile links that appear later are from the notification dropdown.

  function takeBaseline() {
    if (baselineTaken) return;
    baselineTaken = true;
    const links = document.querySelectorAll("a[href]");
    for (const link of links) {
      if (isProfileHref(link.href)) {
        baselineLinks.add(normalizeUrl(link.href));
      }
    }
    console.log(`[LNR] Baseline: ${baselineLinks.size} profile links already on page.`);
  }

  // ─── Extract NEW profile links (not in baseline) ───────────────────

  function extractNewProfileLinks() {
    const urls = [];
    const seen = new Set();

    const links = document.querySelectorAll("a[href]");
    for (const link of links) {
      const href = link.href;
      if (!isProfileHref(href)) continue;

      // ── FILTER: Only capture links whose text says "View Candidate" ──
      const linkText = (link.textContent || "").trim();
      if (!/view\s+candidate/i.test(linkText)) continue;

      // Skip if link is not visible (hidden elements)
      if (link.offsetParent === null && !link.offsetWidth && !link.offsetHeight) continue;

      const norm = normalizeUrl(href);

      // Skip links that were on the page at load time (static navigation, etc.)
      if (baselineLinks.has(norm)) continue;
      // Skip already-opened
      if (openedCandidateUrls.has(norm)) continue;
      // Skip dupes within this batch
      if (seen.has(norm)) continue;
      // Skip "recommended matches"
      if (isSkippableNotification(link)) continue;

      seen.add(norm);
      urls.push(href);
    }

    return urls;
  }

  // ─── Send URLs to background ───────────────────────────────────────

  function sendCandidateUrls(urls) {
    if (!urls || urls.length === 0) return;

    const now = Date.now();
    if (now - lastSendTime < CONFIG.COOLDOWN_MS) {
      const remaining = Math.round((CONFIG.COOLDOWN_MS - (now - lastSendTime)) / 1000);
      console.log(`[LNR] Cooldown active — skipping ${urls.length} URLs (${remaining}s remaining)`);
      return;
    }

    // Mark as opened BEFORE sending
    for (const url of urls) {
      openedCandidateUrls.add(normalizeUrl(url));
    }
    lastSendTime = now;

    console.log(`[LNR] Sending ${urls.length} new candidate URL(s) to background.`);

    chrome.runtime.sendMessage({
      type: "CANDIDATE_LINKS_FOUND",
      candidateUrls: urls,
      timestamp: now,
    });
  }

  // ─── Trigger: detect new profile links appearing ───────────────────
  // This fires when LinkedIn adds notification items to the DOM (on hover/click).
  // We don't need to know the dropdown's class name — we just detect that
  // new profile links appeared that weren't there before.

  function onNewLinksDetected() {
    if (!isEnabled) return;

    // Debounce — wait for the dropdown to finish rendering
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const urls = extractNewProfileLinks();
      if (urls.length > 0) {
        console.log(`[LNR] Found ${urls.length} NEW profile link(s) (not in baseline).`);
        sendCandidateUrls(urls);
      }
    }, CONFIG.DEBOUNCE_MS);
  }

  // ─── MutationObserver: watch for any new nodes with profile links ──

  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Check newly added nodes for profile links
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;

          // Check if this node itself or its children contain profile links
          const links = node.querySelectorAll
            ? node.querySelectorAll('a[href*="/profile/"], a[href*="/in/"], a[href*="/talent/"], a[href*="/hire/"]')
            : [];

          // Also check if the node itself is a profile link
          const selfIsLink = node.tagName === "A" && node.href && isProfileHref(node.href);

          if (links.length > 0 || selfIsLink) {
            onNewLinksDetected();
            return; // One trigger per mutation batch is enough
          }
        }

        // Also detect visibility changes (class/style mutations that reveal elements)
        if (mutation.type === "attributes") {
          const target = mutation.target;
          if (target.nodeType === 1 && target.querySelectorAll) {
            const links = target.querySelectorAll('a[href*="/profile/"], a[href*="/in/"], a[href*="/talent/"], a[href*="/hire/"]');
            if (links.length > 0) {
              onNewLinksDetected();
              return;
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });

    console.log("[LNR] Observer active — watching for new profile links (hover over bell to trigger).");
  }

  // ─── UI Indicator ──────────────────────────────────────────────────

  function showStatusIndicator() {
    let status = document.getElementById("lnr-status-indicator");
    if (!status) {
      status = document.createElement("div");
      status.id = "lnr-status-indicator";
      document.body.appendChild(status);
    }
    status.textContent = "LNR Active — Hover bell to scan";
    status.style.display = "block";
  }

  // ─── Page Diagnostic ───────────────────────────────────────────────

  function runPageDiagnostic() {
    console.log("[LNR] ═══════════════════════════════════════════");
    console.log("[LNR] PAGE DIAGNOSTIC");
    console.log("[LNR] URL:", window.location.href);
    console.log("[LNR] Title:", document.title);

    // Count profile links already on the page
    const allLinks = document.querySelectorAll("a[href]");
    let profileLinkCount = 0;
    for (const link of allLinks) {
      if (isProfileHref(link.href)) profileLinkCount++;
    }
    console.log(`[LNR] Profile links on page: ${profileLinkCount} (these will be in the baseline)`);
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

  // Wait a moment for the page to fully render before taking the baseline
  setTimeout(() => {
    takeBaseline();
    showStatusIndicator();
    runPageDiagnostic();
    setupObserver();

    console.log("[LNR] Content script loaded on:", window.location.href);
    console.log("[LNR] Mode: HOVER — hover over the notification bell to scan profiles");
  }, 3000);
})();
