// netlify/functions/get-places.js
// Queries restaurants, grocery, or rentals by zone for Lucy

exports.handler = async (event, context) => {
  console.log('get-places called with:', event.queryStringParameters || 'no params');
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    let toolCallId = null;
    let isVapiRequest = false;
    let params = {};

    // Check query params first (for browser/GET requests)
    if (event.queryStringParameters) {
      params = event.queryStringParameters;
    }

    // Parse POST body (for Vapi requests)
    if (event.body) {
      try {
        const body = JSON.parse(event.body);

        // Check if this is a Vapi request
        if (body.message?.toolCallList) {
          isVapiRequest = true;
          toolCallId = body.message.toolCallList[0]?.id;
          const args = body.message.toolCallList[0]?.arguments || {};
          params = { ...params, ...args };
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }

    // Required parameters
    const { category, zone } = params;

    // Optional filters
    const {
      cuisine,      // For restaurants
      subcategory,  // For grocery (Full Grocery, Specialty, etc.) or rentals (Bonfire, Bike, etc.)
      price_range,  // For restaurants ($, $$, $$$, $$$$)
      limit         // Max results to return
    } = params;

    if (!category || !zone) {
      const errorMsg = "Error: Missing required parameters. Need 'category' (restaurants, grocery, rentals) and 'zone' (east-30a, central-30a, west-30a, pcb).";
      if (isVapiRequest) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            results: [{ toolCallId: toolCallId || "unknown", result: errorMsg }]
          })
        };
      } else {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, error: errorMsg })
        };
      }
    }

    // Airtable configuration
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID; // ✅ FIXED (was hardcoded)

    // ✅ FIXED: check BOTH vars
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      const errorMsg = "Error: Database not configured.";
      if (isVapiRequest) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            results: [{ toolCallId: toolCallId || "unknown", result: errorMsg }]
          })
        };
      } else {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ success: false, error: errorMsg })
        };
      }
    }

    // Region-aware table mapping
    const regionTableMap = {
      '30A': {
        'restaurants': '30A Restaurants',
        'dining': '30A Restaurants',
        'grocery': '30A Grocery and Essentials',
        'groceries': '30A Grocery and Essentials',
        'rentals': '30A Rentals and Services',
        'services': '30A Rentals and Services',
        'activities': '30A Activities',
        'pets': '30A Dog Friendly Places',
        'dog': '30A Dog Friendly Places',
        'dog-friendly': '30A Dog Friendly Places',
        'beaches': '30A Beaches',
        'beach': '30A Beaches',
        'fitness': '30A Fitness and Wellness',
        'wellness': '30A Fitness and Wellness',
        'health': '30A Fitness and Wellness',
        'shopping': '30A Shopping',
        'rainyday': '30A Rainy Day',
        'rainy-day': '30A Rainy Day',
        'farmersmarket': '30A Farmers Markets',
        'farmers-market': '30A Farmers Markets',
        'farmersmarkets': '30A Farmers Markets'
      },
      'Park_City': {
        'restaurants': 'Park City Dining',
        'dining': 'Park City Dining',
        'grocery': 'Park City Grocery and Essentials',
        'groceries': 'Park City Grocery and Essentials',
        'ski': 'Park City Ski and Activities',
        'activities': 'Park City Events and Activities',
        'transport': 'Park City Transportation',
        'transportation': 'Park City Transportation',
        'getting-around': 'Park City Transportation'
      }
    };

    // Get region from params (passed by frontend), default to 30A
    const rawRegion = params.region || '30A';
    // Normalize: "Park City" → "Park_City", "park_city" → "Park_City", etc.
    const region = rawRegion.replace(/\s+/g, '_');
    const regionLower = region.toLowerCase();
    
    // Match region case-insensitively
    const tableMap = Object.keys(regionTableMap).find(k => k.toLowerCase() === regionLower)
      ? regionTableMap[Object.keys(regionTableMap).find(k => k.toLowerCase() === regionLower)]
      : regionTableMap['30A'];
    const tableName = tableMap[category.toLowerCase()];

    if (!tableName) {
      const errorMsg = `Error: Unknown category '${category}'. Use: restaurants, grocery, rentals, activities, pets, or beaches.`;
      if (isVapiRequest) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            results: [{ toolCallId: toolCallId || "unknown", result: errorMsg }]
          })
        };
      } else {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, error: errorMsg })
        };
      }
    }

    // Build Airtable filter formula
    let filterParts = [];
    let sortField = null;

    // Different filtering logic based on category
    const cat = category.toLowerCase();

    // If zone is "all", don't filter by zone - return all items
    if (zone.toLowerCase() !== 'all') {
      if (cat === 'rentals' || cat === 'services') {
        // Rentals use zones_served multi-select field
        filterParts.push(`FIND(\"${zone}\", {zones_served})`);
      } else if (cat === 'activities' || cat === 'grocery' || cat === 'groceries') {
        // Activities and Grocery: match specific zone OR "all-zones" (for delivery services)
        filterParts.push(`OR({zone}=\"${zone}\", {zone}=\"all-zones\")`);
      } else if (cat === 'pets' || cat === 'dog' || cat === 'dog-friendly') {
        // Pets: match specific zone OR "all-zones"
        filterParts.push(`OR({zone}=\"${zone}\", {zone}=\"all-zones\")`);
      } else if (cat === 'beaches' || cat === 'beach') {
        filterParts.push(`{zone}=\"${zone}\"`);
        sortField = 'distance_rank';
      } else if (cat === 'fitness' || cat === 'wellness' || cat === 'health') {
        // Fitness - try lowercase zone field (Airtable might normalize)
        filterParts.push(`OR({Zone}=\"${zone}\", {zone}=\"${zone}\", {Zone}=\"all-zones\", {zone}=\"all-zones\")`);
      } else if (cat === 'shopping') {
        // Shopping - filter by zone if specified
        filterParts.push(`OR({zone}=\"${zone}\", {zone}=\"all-zones\")`);
      } else if (cat === 'rainyday' || cat === 'rainy-day') {
        // Rainy Day - show all, no zone filter needed
        // Don't add any filter
      } else if (cat === 'farmersmarket' || cat === 'farmers-market' || cat === 'farmersmarkets') {
        // Farmers Market - show all, no zone filter needed
        // Don't add any filter
      } else {
        // Default (restaurants, dining): match specific zone
        filterParts.push(`{zone}=\"${zone}\"`);
      }
    }

    // Add optional filters
    if (cuisine) {
      filterParts.push(`FIND(\"${cuisine}\", {cuisine})`);
    }
    if (subcategory) {
      filterParts.push(`{category}=\"${subcategory}\"`);
    }
    if (price_range) {
      filterParts.push(`{price_range}=\"${price_range}\"`);
    }

    const filterFormula = filterParts.length > 1
      ? `AND(${filterParts.join(', ')})`
      : filterParts[0] || '';

    // Query Airtable
    let airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;
    let hasParams = false;

    // Only add filter if we have one
    if (filterFormula) {
      airtableUrl += `?filterByFormula=${encodeURIComponent(filterFormula)}`;
      hasParams = true;
    }

    // Add sort for beaches
    if (sortField) {
      airtableUrl += `${hasParams ? '&' : '?'}sort[0][field]=${sortField}&sort[0][direction]=asc`;
      hasParams = true;
    }

    // Add limit if specified
    if (limit) {
      airtableUrl += `${hasParams ? '&' : '?'}maxRecords=${limit}`;
    }

    console.log(`Fetching from Airtable: table="${tableName}", filter="${filterFormula}"`);

    const response = await fetch(airtableUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Airtable error for table "${tableName}": ${response.status} - ${errorText}`);
      const errorMsg = `Error: Could not connect to database. Table: ${tableName}, Status: ${response.status}`;
      if (isVapiRequest) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            results: [{ toolCallId: toolCallId || "unknown", result: errorMsg }]
          })
        };
      } else {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ success: false, error: errorMsg, details: errorText })
        };
      }
    }

    const data = await response.json();
    const records = data.records || [];

    // Format results based on category
    if (isVapiRequest) {
      let resultText = '';

      if (records.length === 0) {
        resultText = `No ${category} found in zone ${zone}` + (subcategory ? ` with category ${subcategory}` : '') + '.';
      } else {
        resultText = `Found ${records.length} ${category} in ${zone}:\n\n`;

        records.forEach((record, index) => {
          const r = record.fields;

          if (tableName.includes('Restaurants')) {
            resultText += `${index + 1}. ${r.name || 'Unknown'}
   Area: ${r.area || 'N/A'}
   Cuisine: ${r.cuisine || 'N/A'}
   Price: ${r.price_range || 'N/A'}
   Vibe: ${r.vibe || 'N/A'}
   Must Try: ${r.must_try || 'N/A'}
   Reservations: ${r.reservation_needed || 'No'}
   Happy Hour: ${r.happy_hour === 'Yes' ? `Yes - ${r.happy_hour_times || 'check times'}` : 'No'}
   Pet Friendly: ${r.pet_friendly || 'N/A'}
   Description: ${r.description || 'N/A'}
   Phone: ${r.phone || 'N/A'}

`;
          } else if (tableName.includes('Grocery')) {
            resultText += `${index + 1}. ${r.name || 'Unknown'}
   Category: ${r.category || 'N/A'}
   Area: ${r.area || 'N/A'}
   Hours: ${r.hours || 'N/A'}
   Pharmacy: ${r.pharmacy ? 'Yes' : 'No'}
   Deli/Prepared Food: ${r.deli_prepared || 'No'}
   Delivery: ${r.delivery || 'No'}
   Notes: ${r.notes || 'N/A'}
   Phone: ${r.phone || 'N/A'}

`;
          } else if (tableName.includes('Rentals')) {
            resultText += `${index + 1}. ${r.name || 'Unknown'}
   Category: ${r.category || 'N/A'}
   Starting Price: ${r.starting_price || 'N/A'}
   Areas Served: ${r.areas_served || 'N/A'}
   Services: ${r.services || 'N/A'}
   Notes: ${r.notes || 'N/A'}
   Phone: ${r.phone || 'N/A'}
   Website: ${r.website || 'N/A'}

`;
          } else if (tableName.includes('Dog Friendly')) {
            resultText += `${index + 1}. ${r.name || 'Unknown'}
   Type: ${r.category || 'N/A'}
   Area: ${r.area || 'N/A'}
   Off-Leash: ${r.off_leash || 'No'}
   Cost: ${r.cost || 'Free'}
   Hours: ${r.hours || 'N/A'}
   Description: ${r.description || 'N/A'}
   Tips: ${r.tips || 'N/A'}
   Phone: ${r.phone || 'N/A'}

`;
          } else if (tableName.includes('Beaches')) {
            resultText += `${index + 1}. ${r.name || 'Unknown'}
   Access: ${r.access_type || 'N/A'}
   Description: ${r.description || 'N/A'}
   Lifeguards: ${r.lifeguards || 'No'}
   Parking: ${r.parking || 'N/A'}
   Amenities: ${r.amenities || 'N/A'}

`;
          } else if (tableName.includes('Activities')) {
            resultText += `${index + 1}. ${r.name || 'Unknown'}
   Category: ${r.category || 'N/A'}
   Type: ${r.type || 'N/A'}
   Description: ${r.description || 'N/A'}
   Best Spots: ${r.best_spots || 'N/A'}
   Tips: ${r.tips || 'N/A'}
   Website: ${r.website || 'N/A'}

`;
          }
        });
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          results: [{
            toolCallId: toolCallId,
            result: resultText.trim()
          }]
        })
      };
    } else {
      // Browser request - return raw JSON
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          category: category,
          zone: zone,
          count: records.length,
          places: records.map(r => r.fields)
        })
      };
    }

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};
