/**
 * Profile Scraper - runs on LinkedIn Recruiter profile pages.
 *
 * SAFETY: Only scrapes profiles that were auto-opened by the extension
 * (tagged via URL hash). Respects robots meta tags. Uses randomized delays.
 *
 * Extracts candidate data from the profile and sends it to the
 * background script for screening via the Kimi K2.5 LLM.
 */

(function () {
  "use strict";

  // ─── Safety Gate: Only scrape auto-opened tabs ────────────────────
  // The background script appends #lnr-auto to URLs it opens.
  // If this hash isn't present, the user navigated here manually — don't scrape.
  if (!window.location.hash.includes("lnr-auto")) {
    console.log("[LNR Detector] Profile not auto-opened — skipping scrape.");
    return;
  }

  // Clean the hash from the URL so it doesn't look suspicious
  if (history.replaceState) {
    const cleanUrl = window.location.href.replace(/#lnr-auto/, "").replace(/#$/, "");
    history.replaceState(null, "", cleanUrl);
  }

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
    scrapeAttempts++;

    if (!isScrapingAllowed()) {
      console.log("[LNR Detector] Page robots meta disallows scraping — skipping.");
      return;
    }

    // Gather all visible text from the profile page
    const profileData = extractProfileData();

    if (!profileData.rawText || profileData.rawText.length < 100) {
      // Page likely hasn't loaded yet
      if (scrapeAttempts < MAX_ATTEMPTS) {
        setTimeout(scrapeProfile, randomDelay(1500, 3500));
        return;
      }
    }

    console.log("[LNR Detector] Scraped profile data:", profileData);

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
    // Look for links pointing to linkedin.com/in/ on the recruiter profile page
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

  // Start scraping after a randomized delay (looks more human)
  setTimeout(scrapeProfile, randomDelay(2000, 4500));

  console.log("[LNR Detector] Profile scraper loaded (auto-opened tab).");
})();
