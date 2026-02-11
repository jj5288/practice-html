/**
 * ============================================================
 * GOOGLE APPS SCRIPT — Paste this into your Google Sheet
 * ============================================================
 *
 * SETUP INSTRUCTIONS:
 *
 * 1. Create a new Google Sheet
 * 2. Add these headers in Row 1:
 *    A1:  Timestamp
 *    B1:  Fit Score
 *    C1:  First Name
 *    D1:  Last Name
 *    E1:  Current Job
 *    F1:  Current Location
 *    G1:  LinkedIn Recruiter Profile URL
 *    H1:  Open to Work Title(s)
 *    I1:  On-Site Location Preferred
 *    J1:  Practice Area
 *    K1:  Salary Estimate
 *    L1:  Ready to Move
 *    M1:  Physical Move?
 *    N1:  Relocation Note
 *    O1:  Public LinkedIn URL
 *
 * 3. Click Extensions > Apps Script
 * 4. Delete any existing code and paste this entire file
 * 5. Click Deploy > New deployment
 * 6. Choose "Web app" as the type
 * 7. Set "Execute as" to "Me"
 * 8. Set "Who has access" to "Anyone"
 * 9. Click Deploy and authorize when prompted
 * 10. Copy the Web app URL — paste it into the extension popup
 *
 * NOTE: If you already deployed a previous version, click
 *       Deploy > Manage deployments > Edit (pencil icon) >
 *       set Version to "New version" > Deploy
 *
 * ============================================================
 */

// ─── EMAIL CONFIG ───────────────────────────────────────────────────
// Change this to your email address for recruiter alerts
var RECRUITER_ALERT_EMAIL = "john@vollrecruiting.com";

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Route to the correct handler based on action
    if (data.action === "recruiter_alert") {
      return handleRecruiterAlert(data);
    }

    // Default: add candidate to sheet
    return handleAddCandidate(data);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Adds a qualified candidate to the spreadsheet.
 * Inserts at Row 2 so newest candidates are always at the top.
 */
function handleAddCandidate(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  sheet.insertRowAfter(1);

  sheet.getRange(2, 1).setValue(data.timestamp || new Date().toISOString());
  sheet.getRange(2, 2).setValue(data.fitScore || "");
  sheet.getRange(2, 3).setValue(data.firstName || "");
  sheet.getRange(2, 4).setValue(data.lastName || "");
  sheet.getRange(2, 5).setValue(data.currentJob || "");
  sheet.getRange(2, 6).setValue(data.currentLocation || "");
  sheet.getRange(2, 7).setValue(data.profileUrl || "");
  sheet.getRange(2, 8).setValue(data.openToWorkTitles || "");
  sheet.getRange(2, 9).setValue(data.onSiteLocationPreferred || "");
  sheet.getRange(2, 10).setValue(data.practiceArea || "");
  sheet.getRange(2, 11).setValue(data.salaryEstimate || "");
  sheet.getRange(2, 12).setValue(data.readyToMove || "");
  sheet.getRange(2, 13).setValue(data.physicalMove || "");
  sheet.getRange(2, 14).setValue(data.physicalMoveNote || "");
  sheet.getRange(2, 15).setValue(data.publicProfileUrl || "");

  // Highlight relocating candidates
  if (data.physicalMove === "YES - RELOCATING") {
    sheet.getRange(2, 13).setBackground("#fff2cc"); // light yellow
  }

  // Color-code fit score
  var score = parseInt(data.fitScore);
  if (score >= 8) {
    sheet.getRange(2, 2).setBackground("#d9ead3"); // green
  } else if (score >= 5) {
    sheet.getRange(2, 2).setBackground("#fff2cc"); // yellow
  } else if (score > 0) {
    sheet.getRange(2, 2).setBackground("#f4cccc"); // red
  }

  return ContentService.createTextOutput(
    JSON.stringify({ status: "success" })
  ).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Sends an email alert when a legal recruiter is detected.
 * These are rare and critical — potential partners or competitors.
 */
function handleRecruiterAlert(data) {
  var subject = "LEGAL RECRUITER DETECTED: " + (data.firstName || "") + " " + (data.lastName || "");

  var body = "A legal recruiter was detected in your LinkedIn Recruiter notifications.\n\n"
    + "Name: " + (data.firstName || "") + " " + (data.lastName || "") + "\n"
    + "Current Position: " + (data.currentJob || "Unknown") + "\n"
    + "Location: " + (data.currentLocation || "Unknown") + "\n"
    + "Recruiter Notes: " + (data.recruiterNote || "None") + "\n"
    + "Profile URL: " + (data.profileUrl || "N/A") + "\n"
    + "Detected at: " + (data.timestamp || new Date().toISOString()) + "\n\n"
    + "— LinkedIn Recruiter Detector (Voll Recruiting)";

  var htmlBody = "<div style='font-family: Arial, sans-serif; max-width: 600px;'>"
    + "<h2 style='color: #e94560; margin-bottom: 4px;'>Legal Recruiter Detected</h2>"
    + "<p style='color: #888; font-size: 12px; margin-top: 0;'>LinkedIn Recruiter Notification Alert</p>"
    + "<table style='width: 100%; border-collapse: collapse;'>"
    + "<tr><td style='padding: 8px; font-weight: bold; color: #555;'>Name</td>"
    + "<td style='padding: 8px;'>" + (data.firstName || "") + " " + (data.lastName || "") + "</td></tr>"
    + "<tr style='background: #f9f9f9;'><td style='padding: 8px; font-weight: bold; color: #555;'>Position</td>"
    + "<td style='padding: 8px;'>" + (data.currentJob || "Unknown") + "</td></tr>"
    + "<tr><td style='padding: 8px; font-weight: bold; color: #555;'>Location</td>"
    + "<td style='padding: 8px;'>" + (data.currentLocation || "Unknown") + "</td></tr>"
    + "<tr style='background: #f9f9f9;'><td style='padding: 8px; font-weight: bold; color: #555;'>Intel</td>"
    + "<td style='padding: 8px;'>" + (data.recruiterNote || "None") + "</td></tr>"
    + "<tr><td style='padding: 8px; font-weight: bold; color: #555;'>Recruiter Profile</td>"
    + "<td style='padding: 8px;'><a href='" + (data.profileUrl || "#") + "'>View in Recruiter</a></td></tr>"
    + "<tr style='background: #f9f9f9;'><td style='padding: 8px; font-weight: bold; color: #555;'>Public Profile</td>"
    + "<td style='padding: 8px;'><a href='" + (data.publicProfileUrl || "#") + "'>View Public LinkedIn</a></td></tr>"
    + "</table>"
    + "<p style='color: #aaa; font-size: 11px; margin-top: 20px;'>Sent by LinkedIn Recruiter Detector — Voll Recruiting</p>"
    + "</div>";

  MailApp.sendEmail({
    to: RECRUITER_ALERT_EMAIL,
    subject: subject,
    body: body,
    htmlBody: htmlBody,
  });

  return ContentService.createTextOutput(
    JSON.stringify({ status: "success", emailSent: true })
  ).setMimeType(ContentService.MimeType.JSON);
}

// Optional: test endpoint to verify the webhook is working
function doGet(e) {
  return ContentService.createTextOutput(
    JSON.stringify({
      status: "ok",
      message: "LinkedIn Recruiter Detector webhook is active.",
    })
  ).setMimeType(ContentService.MimeType.JSON);
}
