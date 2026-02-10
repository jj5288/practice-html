/**
 * ============================================================
 * GOOGLE APPS SCRIPT — Paste this into your Google Sheet
 * ============================================================
 *
 * SETUP INSTRUCTIONS:
 *
 * 1. Create a new Google Sheet
 * 2. Add these headers in Row 1:
 *    A1: Timestamp
 *    B1: First Name
 *    C1: Last Name
 *    D1: Current Job
 *    E1: Current Location
 *    F1: LinkedIn Recruiter Profile URL
 *    G1: Open to Work Title(s)
 *    H1: On-Site Location Preferred
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
 * ============================================================
 */

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);

    // Insert new candidates at Row 2 (right below the header) so
    // the newest candidates always appear at the top of the sheet.
    sheet.insertRowAfter(1);

    sheet.getRange(2, 1).setValue(data.timestamp || new Date().toISOString());
    sheet.getRange(2, 2).setValue(data.firstName || "");
    sheet.getRange(2, 3).setValue(data.lastName || "");
    sheet.getRange(2, 4).setValue(data.currentJob || "");
    sheet.getRange(2, 5).setValue(data.currentLocation || "");
    sheet.getRange(2, 6).setValue(data.profileUrl || "");
    sheet.getRange(2, 7).setValue(data.openToWorkTitles || "");
    sheet.getRange(2, 8).setValue(data.onSiteLocationPreferred || "");

    return ContentService.createTextOutput(
      JSON.stringify({ status: "success" })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
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
