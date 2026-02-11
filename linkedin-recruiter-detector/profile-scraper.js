/**
 * Profile Scraper - runs on LinkedIn Recruiter profile pages.
 *
 * SAFETY: Only scrapes when the background script confirms this tab
 * was auto-opened by the extension. Respects robots meta tags.
 * Uses randomized delays.
 *
 * Extracts candidate data from the profile and sends it to the
 * background script for screening via the Kimi K2.5 LLM.
 */

(function () {
  "use strict";

  let hasScraped = false;

  // ─── Ask background if we should scrape this tab ──────────────────
  // The background tracks which tab IDs it auto-opened.
  // This is more reliable than URL hash which can get stripped.
  chrome.runtime.sendMessage({ type: "CHECK_AUTO_OPENED" }, (response) => {
    if (chrome.runtime.lastError) {
      console.log("[LNR Scraper] Could not reach background:", chrome.runtime.lastError.message);
      return;
    }

    if (response && response.autoOpened) {
      console.log("[LNR Scraper] Background confirmed auto-opened tab — will scrape.");
      setTimeout(scrapeProfile, randomDelay(2000, 4500));
    } else {
      console.log("[LNR Scraper] Not auto-opened — skipping scrape.");
    }
  });

  // Also listen for a direct START_SCRAPE message from background
  // (backup trigger in case the CHECK_AUTO_OPENED races with tab creation)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "START_SCRAPE" && !hasScraped) {
      console.log("[LNR Scraper] Received START_SCRAPE from background.");
      setTimeout(scrapeProfile, randomDelay(2000, 4500));
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

  // ─── Randomized delay helper ──────────────────────────────────────
  function randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  }

  // Wait for the profile to fully load before scraping
  let scrapeAttempts = 0;
  const MAX_ATTEMPTS = 15;

  function scrapeProfile() {
    if (hasScraped) return;
    scrapeAttempts++;

    if (!isScrapingAllowed()) {
      console.log("[LNR Scraper] Page robots meta disallows scraping — skipping.");
      return;
    }

    // Gather all visible text from the profile page
    const profileData = extractProfileData();

    if (!profileData.rawText || profileData.rawText.length < 100) {
      // Page likely hasn't loaded yet
      if (scrapeAttempts < MAX_ATTEMPTS) {
        console.log(`[LNR Scraper] Page not ready (attempt ${scrapeAttempts}/${MAX_ATTEMPTS}), retrying...`);
        setTimeout(scrapeProfile, randomDelay(1500, 3500));
        return;
      }
      console.log("[LNR Scraper] Max attempts reached — scraping with what we have.");
    }

    hasScraped = true;
    console.log("[LNR Scraper] Scraped profile data:", profileData.name, profileData.headline);

    // Send to background for LLM screening
    chrome.runtime.sendMessage({
      type: "PROFILE_SCRAPED",
      profile: profileData,
      url: window.location.href,
      timestamp: Date.now(),
    });
  }

  /**
   * Extracts structured data from a LinkedIn Recruiter profile page.
   * Uses multiple selector strategies since LinkedIn's DOM varies.
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
    ];
    for (const sel of locationSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        data.location = el.textContent.trim();
        break;
      }
    }

    // --- Experience section ---
    const expSections = document.querySelectorAll(
      '[class*="experience"] li, [class*="position"] li, [id*="experience"] li'
    );
    for (const item of expSections) {
      const text = item.textContent.trim().replace(/\s+/g, " ");
      if (text.length > 10) {
        data.experience.push(text);
      }
    }

    // --- Education section ---
    const eduSections = document.querySelectorAll(
      '[class*="education"] li, [id*="education"] li'
    );
    for (const item of eduSections) {
      const text = item.textContent.trim().replace(/\s+/g, " ");
      if (text.length > 10) {
        data.education.push(text);
      }
    }

    // --- Open to work info ---
    const otwSelectors = [
      '[class*="open-to-work"]',
      '[class*="openToWork"]',
      '[class*="spotlight"]',
      '[class*="hiring-preference"]',
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
      document.body;
    data.rawText = mainContent.innerText.substring(0, 8000);

    return data;
  }

  console.log("[LNR Scraper] Profile scraper loaded, checking with background...");
})();
