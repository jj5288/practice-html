/**
 * Profile Scraper - runs on LinkedIn Recruiter/Talent profile pages.
 *
 * ACTIVATION MODES:
 *  1. Auto-opened tabs: Background confirms via CHECK_AUTO_OPENED → scrapes immediately
 *  2. Any profile page: If user has auto-screen ON, scrapes ALL profile pages
 *     (This ensures screening works even if tab-ID tracking fails)
 *  3. Backup: Background sends START_SCRAPE after tab loads
 *
 * SAFETY: Respects robots meta tags. Uses randomized delays.
 */

(function () {
  "use strict";

  let hasScraped = false;
  let isAutoOpened = false;

  console.log("[LNR Scraper] Profile scraper loaded on:", window.location.href);

  // ─── Check if this is a candidate profile page ──────────────────
  // Skip pages that are clearly NOT individual profiles
  function isProfilePage() {
    const url = window.location.href;
    // Positive signals: URL contains profile-related paths
    if (url.includes("/profile/") || url.includes("/in/") || url.includes("/hire/")) {
      return true;
    }
    // For /recruiter/ and /talent/ URLs, check if the page has profile content
    // (search results pages also match these patterns)
    if (url.includes("/search")) return false;
    if (url.includes("/pipeline")) return false;
    if (url.includes("/projects")) return false;
    if (url.includes("/settings")) return false;
    if (url.includes("/reporting")) return false;
    if (url.includes("/admin")) return false;
    // If it's a /talent/ or /recruiter/ URL with an ID-like segment, probably a profile
    const pathParts = new URL(url).pathname.split("/").filter(Boolean);
    if (pathParts.length >= 3) return true; // e.g., /talent/hire/12345 or /recruiter/profile/ABC
    return false;
  }

  if (!isProfilePage()) {
    console.log("[LNR Scraper] Not a profile page — skipping.");
    return;
  }

  // ─── Ask background: is this tab auto-opened AND is auto-screen on? ─
  chrome.runtime.sendMessage({ type: "CHECK_SHOULD_SCRAPE" }, (response) => {
    if (chrome.runtime.lastError) {
      console.log("[LNR Scraper] Could not reach background:", chrome.runtime.lastError.message);
      return;
    }

    if (!response) {
      console.log("[LNR Scraper] No response from background.");
      return;
    }

    console.log("[LNR Scraper] Background response:", JSON.stringify(response));

    if (response.autoOpened) {
      // Tab was auto-opened by the extension — always scrape
      isAutoOpened = true;
      console.log("[LNR Scraper] Auto-opened tab confirmed — will scrape.");
      setTimeout(scrapeProfile, randomDelay(2000, 4500));
    } else if (response.autoScreenEnabled) {
      // Auto-screen is ON — scrape all profile pages (catches manual browsing too)
      console.log("[LNR Scraper] Auto-screen enabled — will scrape this profile.");
      setTimeout(scrapeProfile, randomDelay(2000, 4500));
    } else {
      console.log("[LNR Scraper] Auto-screen disabled and not auto-opened — skipping.");
    }
  });

  // Backup: listen for START_SCRAPE from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "START_SCRAPE" && !hasScraped) {
      console.log("[LNR Scraper] Received START_SCRAPE from background.");
      setTimeout(scrapeProfile, randomDelay(1000, 2500));
    }
  });

  // ─── Safety Gate: Respect robots meta tags ────────────────────────
  function isScrapingAllowed() {
    const robotsMeta = document.querySelector('meta[name="robots"]');
    if (robotsMeta) {
      const content = (robotsMeta.getAttribute("content") || "").toLowerCase();
      if (content.includes("noindex") || content.includes("nofollow")) {
        return false;
      }
    }
    return true;
  }

  function randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  }

  // Wait for the profile to fully load before scraping
  let scrapeAttempts = 0;
  const MAX_ATTEMPTS = 20; // Increased from 15 — give LinkedIn more time to render

  function scrapeProfile() {
    if (hasScraped) return;
    scrapeAttempts++;

    if (!isScrapingAllowed()) {
      console.log("[LNR Scraper] Page robots meta disallows scraping — skipping.");
      return;
    }

    // Gather all visible text from the profile page
    const profileData = extractProfileData();

    if (!profileData.rawText || profileData.rawText.length < 50) {
      // Page likely hasn't loaded yet
      if (scrapeAttempts < MAX_ATTEMPTS) {
        console.log(`[LNR Scraper] Page not ready (attempt ${scrapeAttempts}/${MAX_ATTEMPTS}, text length: ${(profileData.rawText || "").length}), retrying...`);
        setTimeout(scrapeProfile, randomDelay(1500, 3500));
        return;
      }
      console.log("[LNR Scraper] Max attempts reached — scraping with what we have.");
    }

    hasScraped = true;
    console.log("[LNR Scraper] Scraped profile:", profileData.name || "(no name)", "|", profileData.headline || "(no headline)", "| text length:", profileData.rawText.length);

    // Send to background for LLM screening
    chrome.runtime.sendMessage({
      type: "PROFILE_SCRAPED",
      profile: profileData,
      url: window.location.href,
      isAutoOpened: isAutoOpened,
      timestamp: Date.now(),
    });
  }

  /**
   * Extracts structured data from a LinkedIn Recruiter profile page.
   * Uses multiple selector strategies since LinkedIn's DOM varies by page type.
   */
  function extractProfileData() {
    const data = {
      rawText: "",
      name: "",
      headline: "",
      location: "",
      currentJob: "",
      experience: [],
      education: [],
      openToWork: "",
      profileUrl: window.location.href,
      publicProfileUrl: "",
    };

    // --- Name ---
    const nameSelectors = [
      "h1",
      '[data-test-profile-name]',
      '[class*="profile-name"]',
      '[class*="artdeco-entity-lockup__title"]',
      ".profile-topcard-person-entity__name",
      ".top-card__full-name",
      '[class*="topcard"] [class*="name"]',
      '[class*="profile-top"] h1',
    ];
    for (const sel of nameSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        data.name = el.textContent.trim();
        break;
      }
    }

    // --- Headline / Current Title ---
    const headlineSelectors = [
      '[data-test-profile-headline]',
      '[class*="profile-headline"]',
      '[class*="artdeco-entity-lockup__subtitle"]',
      ".profile-topcard__current-positions",
      ".top-card__headline",
      '[class*="topcard"] [class*="headline"]',
      '[class*="topcard"] [class*="position"]',
      "h2",
    ];
    for (const sel of headlineSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        data.headline = el.textContent.trim();
        break;
      }
    }

    // --- Location ---
    const locationSelectors = [
      '[class*="profile-location"]',
      '[class*="location"]',
      '[class*="topcard__location"]',
      '[data-test-profile-location]',
      '[class*="topcard"] [class*="geo"]',
    ];
    for (const sel of locationSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        data.location = el.textContent.trim();
        break;
      }
    }

    // --- Experience section ---
    const expSelectors = [
      '[class*="experience"] li',
      '[class*="position"] li',
      '[id*="experience"] li',
      '[class*="experience-section"] li',
      '[data-section="experience"] li',
    ];
    for (const selector of expSelectors) {
      const items = document.querySelectorAll(selector);
      for (const item of items) {
        const text = item.textContent.trim().replace(/\s+/g, " ");
        if (text.length > 10) {
          data.experience.push(text);
        }
      }
      if (data.experience.length > 0) break;
    }

    // --- Education section ---
    const eduSelectors = [
      '[class*="education"] li',
      '[id*="education"] li',
      '[data-section="education"] li',
    ];
    for (const selector of eduSelectors) {
      const items = document.querySelectorAll(selector);
      for (const item of items) {
        const text = item.textContent.trim().replace(/\s+/g, " ");
        if (text.length > 10) {
          data.education.push(text);
        }
      }
      if (data.education.length > 0) break;
    }

    // --- Open to work info ---
    const otwSelectors = [
      '[class*="open-to-work"]',
      '[class*="openToWork"]',
      '[class*="spotlight"]',
      '[class*="hiring-preference"]',
      '[class*="open-to"]',
    ];
    for (const sel of otwSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        data.openToWork += el.textContent.trim() + " ";
      }
    }
    data.openToWork = data.openToWork.trim();

    // --- Public LinkedIn profile URL ---
    const allLinks = document.querySelectorAll('a[href*="linkedin.com/in/"], a[href*="/in/"]');
    for (const link of allLinks) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/(?:https?:\/\/(?:www\.)?linkedin\.com)?\/in\/[\w-]+/);
      if (match) {
        data.publicProfileUrl = match[0].startsWith("/in/")
          ? "https://www.linkedin.com" + match[0]
          : match[0];
        break;
      }
    }

    // --- Current job (from experience or headline) ---
    if (data.experience.length > 0) {
      data.currentJob = data.experience[0];
    } else {
      data.currentJob = data.headline;
    }

    // --- Full page text as fallback for LLM analysis ---
    const mainContent =
      document.querySelector('[class*="profile"]') ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;
    data.rawText = mainContent.innerText.substring(0, 8000);

    return data;
  }
})();
