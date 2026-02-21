// netlify/functions/get-beach-flags.js
// API endpoint for Lucy (Vapi) to fetch current beach flag status from Airtable.
// Called when a guest asks: "What color are the flags?" / "Is it safe to swim?"
//
// Handles both:
//   - Direct browser requests (GET)
//   - Vapi tool calls (POST with specific body format)

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    const tableName = "Beach_Conditions";
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableName}?maxRecords=1`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Airtable returned ${response.status}`);
    }

    const data = await response.json();

    let flagColor = "unknown";
    let lastUpdated = null;
    let description = "Beach flag data is not yet available.";
    let safetyTip = "Check the flags at your nearest beach access before entering the water.";

    if (data.records && data.records.length > 0) {
      const record = data.records[0].fields;
      flagColor = record.Flag_Color || "unknown";
      lastUpdated = record.Last_Updated || null;

      const flagInfo = {
        green: {
          description: "Green flags are flying — low hazard with calm conditions.",
          safetyTip: "Conditions are calm, but always exercise caution in the Gulf. Swim near a lifeguard when possible.",
        },
        yellow: {
          description: "Yellow flags are flying — medium hazard with moderate surf and/or currents.",
          safetyTip: "Use caution when entering the water. Moderate currents may be present. Swim near a lifeguard and never swim alone.",
        },
        red: {
          description: "Red flags are flying — high hazard with high surf and/or strong currents.",
          safetyTip: "Dangerous conditions. Only experienced swimmers should enter, and with extreme caution. Stay knee-deep or less.",
        },
        "double red": {
          description: "Double red flags are flying — the water is CLOSED to the public.",
          safetyTip: "Do NOT enter the water. It is illegal and you can be fined $500 and face criminal charges. Enjoy the beach from the sand!",
        },
        purple: {
          description: "Purple flags are flying — dangerous marine pests such as jellyfish are present.",
          safetyTip: "Watch for jellyfish and other marine life. If stung, notify a lifeguard. Vinegar can help with jellyfish stings.",
        },
      };

      if (flagInfo[flagColor]) {
        description = flagInfo[flagColor].description;
        safetyTip = flagInfo[flagColor].safetyTip;
      } else if (flagColor.includes("/")) {
        const colors = flagColor.split("/").map((c) => c.trim());
        description = colors.map((c) => flagInfo[c]?.description || `${c} flags are flying.`).join(" Also, ");
        safetyTip = colors.map((c) => flagInfo[c]?.safetyTip).filter(Boolean).join(" ");
      }
    }

    // Build the result object
    const resultData = {
      flagColor,
      lastUpdated,
      description,
      safetyTip,
    };

    // Check if this is a Vapi tool call (POST with message body)
    if (event.httpMethod === "POST" && event.body) {
      let vapiBody;
      try {
        vapiBody = JSON.parse(event.body);
      } catch (e) {
        vapiBody = null;
      }

      // Vapi sends a "message" object with tool calls
      if (vapiBody && vapiBody.message) {
        const toolCallId = vapiBody.message.toolCallList?.[0]?.id
          || vapiBody.message.toolCalls?.[0]?.id
          || "beach-flags-call";

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            results: [
              {
                toolCallId: toolCallId,
                result: JSON.stringify(resultData),
              },
            ],
          }),
        };
      }
    }

    // Regular browser/API request — return plain JSON
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(resultData),
    };

  } catch (error) {
    console.error("get-beach-flags error:", error);

    const errorResult = {
      flagColor: "unknown",
      description: "I'm having trouble checking the beach flags right now.",
      safetyTip: "You can check the flags at your nearest beach access, or text FLAG to 31279 for the latest update from South Walton Fire District.",
    };

    // Check if this is a Vapi call even on error
    if (event.httpMethod === "POST" && event.body) {
      let vapiBody;
      try {
        vapiBody = JSON.parse(event.body);
      } catch (e) {
        vapiBody = null;
      }

      if (vapiBody && vapiBody.message) {
        const toolCallId = vapiBody.message.toolCallList?.[0]?.id
          || vapiBody.message.toolCalls?.[0]?.id
          || "beach-flags-call";

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            results: [
              {
                toolCallId: toolCallId,
                result: JSON.stringify(errorResult),
              },
            ],
          }),
        };
      }
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify(errorResult),
    };
  }
};
