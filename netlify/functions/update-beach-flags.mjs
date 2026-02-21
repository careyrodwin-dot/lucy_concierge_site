// netlify/functions/update-beach-flags.mjs
// Scheduled function: Scrapes SWFD.org for current beach flag color
// and updates Airtable with the result.
//
// Schedule: Runs at 9:05 AM CT and 1:05 PM CT (after SWFD updates at 9 AM and 1 PM)
//
// Required Netlify Environment Variables:
//   AIRTABLE_API_KEY  - Your Airtable personal access token
//   AIRTABLE_BASE_ID  - Your Airtable base ID (e.g., appGNDpquNICG4vGa)

const SWFD_URL = "https://www.swfd.org/beach-safety/surf-conditions";

// --- Valid flag colors ---
const VALID_FLAGS = ["green", "yellow", "red", "double red", "purple"];

// --- Scrape SWFD website for flag color ---
async function scrapeBeachFlag() {
  const response = await fetch(SWFD_URL, {
    headers: {
      "User-Agent": "LucyConcierge-BeachFlagBot/1.0 (vacation rental guest assistant)",
    },
  });

  if (!response.ok) {
    throw new Error(`SWFD returned HTTP ${response.status}`);
  }

  const html = await response.text();

  // Pattern: "Current surf conditions are [color]"
  // This appears in the site's navigation banner
  const match = html.match(/Current surf conditions are\s*\n?\s*(\w[\w\s]*?)\s*\./i);

  if (!match) {
    throw new Error("Could not find flag status pattern in SWFD page");
  }

  const rawColor = match[1].trim().toLowerCase();

  // Validate it's a recognized flag color
  if (!VALID_FLAGS.includes(rawColor)) {
    // Check for compound flags like "red / purple" or "yellow and purple"
    const colors = rawColor.split(/[\/,&]|\band\b/).map((c) => c.trim()).filter(Boolean);
    const validColors = colors.filter((c) => VALID_FLAGS.includes(c));

    if (validColors.length > 0) {
      return validColors.join(" / ");
    }

    throw new Error(`Unrecognized flag color: "${rawColor}"`);
  }

  return rawColor;
}

// --- Update Airtable ---
async function updateAirtable(flagColor) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    throw new Error("Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID env vars");
  }

  const tableName = "Beach_Conditions";
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableName}`;

  // First, check if a record already exists (we'll maintain a single record)
  const listResponse = await fetch(`${url}?maxRecords=1`, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!listResponse.ok) {
    const errText = await listResponse.text();
    throw new Error(`Airtable list failed: ${listResponse.status} - ${errText}`);
  }

  const listData = await listResponse.json();
  const now = new Date().toISOString();

  const fields = {
    Flag_Color: flagColor,
    Last_Updated: now,
    Source: "SWFD.org (auto-scraped)",
  };

  if (listData.records && listData.records.length > 0) {
    // Update existing record
    const recordId = listData.records[0].id;
    const updateResponse = await fetch(`${url}/${recordId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });

    if (!updateResponse.ok) {
      const errText = await updateResponse.text();
      throw new Error(`Airtable update failed: ${updateResponse.status} - ${errText}`);
    }

    return { action: "updated", recordId, fields };
  } else {
    // Create new record
    const createResponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });

    if (!createResponse.ok) {
      const errText = await createResponse.text();
      throw new Error(`Airtable create failed: ${createResponse.status} - ${errText}`);
    }

    const created = await createResponse.json();
    return { action: "created", recordId: created.id, fields };
  }
}

// --- Netlify Scheduled Function Handler ---
// Cron schedule is defined in netlify.toml
export default async (req) => {
  console.log(`[Beach Flag Updater] Running at ${new Date().toISOString()}`);

  try {
    // Step 1: Scrape SWFD for current flag color
    const flagColor = await scrapeBeachFlag();
    console.log(`[Beach Flag Updater] Detected flag color: ${flagColor}`);

    // Step 2: Update Airtable
    const result = await updateAirtable(flagColor);
    console.log(`[Beach Flag Updater] Airtable ${result.action}: ${JSON.stringify(result.fields)}`);

    return new Response(
      JSON.stringify({
        success: true,
        flagColor,
        ...result,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error(`[Beach Flag Updater] ERROR: ${error.message}`);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

// --- Schedule Configuration ---
// This is picked up by Netlify from netlify.toml,
// but can also be exported here as a backup:
export const config = {
  // 9:05 AM CT and 1:05 PM CT
  // During CDT (Mar-Nov): CT = UTC-5 → 14:05 and 18:05 UTC
  // During CST (Nov-Mar): CT = UTC-6 → 15:05 and 19:05 UTC
  // Using CDT schedule below — see netlify.toml for notes on adjusting
  schedule: "5 14,18 * * *",
};
