/**
 * Profile Scraper - runs on LinkedIn Recruiter profile pages.
 *
 * Extracts candidate data from the profile and sends it to the
 * background script for screening via the Kimi K2.5 LLM.
 */

(function () {
  "use strict";

  // Wait for the profile to fully load before scraping
  let scrapeAttempts = 0;
  const MAX_ATTEMPTS = 15;
  const RETRY_MS = 2000;

  function scrapeProfile() {
    scrapeAttempts++;

    // Gather all visible text from the profile page
    const profileData = extractProfileData();

    if (!profileData.rawText || profileData.rawText.length < 100) {
      // Page likely hasn't loaded yet
      if (scrapeAttempts < MAX_ATTEMPTS) {
        setTimeout(scrapeProfile, RETRY_MS);
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

    // --- Current job (from experience or headline) ---
    if (data.experience.length > 0) {
      data.currentJob = data.experience[0];
    } else {
      data.currentJob = data.headline;
    }

    // --- Full page text as fallback for LLM analysis ---
    // Get the main profile content area, or fall back to body
    const mainContent =
      document.querySelector('[class*="profile"]') ||
      document.querySelector("main") ||
      document.body;
    data.rawText = mainContent.innerText.substring(0, 8000);

    return data;
  }

  // Start scraping after a short delay to let the page render
  setTimeout(scrapeProfile, 2000);

  console.log("[LNR Detector] Profile scraper loaded.");
})();
