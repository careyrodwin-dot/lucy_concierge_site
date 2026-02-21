// Netlify Function: getPropertyInfo.js
// This function routes to the correct regional tables based on property Region
// Uses native fetch instead of airtable package (no dependencies needed)

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  BASE_ID: process.env.AIRTABLE_BASE_ID,
  API_KEY: process.env.AIRTABLE_API_KEY,
  
  // Core tables
  TABLES: {
    properties: 'Properties',
    propertyGroups: 'Property Management Groups',
  },
  
  // Region-specific tables
  REGIONS: {
    '30A': {
      restaurants: '30A Restaurants',
      thingsToDo: '30A Activities',
      groceries: '30A Groceries',
      dogFriendlyPlaces: '30A Dog Friendly Places',
      beaches: '30A Beaches',
      rentalsAndServices: '30A Rentals and Services',
      fitnessAndWellness: '30A Fitness and Wellness',
      shopping: '30A Shopping',
      rainyDay: '30A Rainy Day',
      farmersMarkets: '30A Farmers Markets',
      groceryAndEssentials: '30A Grocery and Essentials',
    },
    'N_GA': {
      restaurants: 'N_GA Restaurants',
      thingsToDo: 'N_GA Things To Do',
      groceries: 'N_GA Groceries',
    }
  }
};

// =============================================================================
// AIRTABLE API HELPERS (using native fetch)
// =============================================================================

async function airtableFetch(endpoint) {
  const url = `https://api.airtable.com/v0/${CONFIG.BASE_ID}/${endpoint}`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${CONFIG.API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Airtable API error: ${response.status} - ${error}`);
  }
  
  return response.json();
}

async function fetchTableRecords(tableName, filterFormula = null, maxRecords = 100) {
  try {
    let endpoint = encodeURIComponent(tableName);
    const params = new URLSearchParams();
    
    if (filterFormula) {
      params.append('filterByFormula', filterFormula);
    }
    params.append('maxRecords', maxRecords.toString());
    
    const queryString = params.toString();
    if (queryString) {
      endpoint += `?${queryString}`;
    }
    
    const data = await airtableFetch(endpoint);
    
    return (data.records || []).map(record => ({
      id: record.id,
      ...record.fields
    }));
  } catch (error) {
    console.error(`Error fetching from ${tableName}:`, error.message);
    return [];
  }
}

async function fetchRecordById(tableName, recordId) {
  try {
    const endpoint = `${encodeURIComponent(tableName)}/${recordId}`;
    const data = await airtableFetch(endpoint);
    return { id: data.id, ...data.fields };
  } catch (error) {
    console.error(`Error fetching record ${recordId} from ${tableName}:`, error.message);
    return null;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function resolveRegion(regionField, zoneField) {
  if (regionField && regionField.trim() !== '') {
    return regionField.trim();
  }
  
  if (zoneField) {
    const zoneLower = zoneField.toLowerCase();
    if (zoneLower.includes('30a') || zoneLower === 'east-30a' || zoneLower === 'west-30a' || zoneLower === 'central-30a') {
      return '30A';
    }
    if (zoneLower === 'north-ga-mountains' || zoneLower.includes('rabun')) {
      return 'N_GA';
    }
  }
  
  return '30A';
}

function getRegionTables(region) {
  return CONFIG.REGIONS[region] || CONFIG.REGIONS['30A'];
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // Parse request
    let slug;
    let isVapiRequest = false;
    let toolCallId = null;
    
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      
      console.log('POST body received:', JSON.stringify(body, null, 2));
      
      // Handle Vapi POST requests - check multiple possible formats
      if (body.message?.toolCalls?.[0]) {
        isVapiRequest = true;
        toolCallId = body.message.toolCalls[0].id;
        slug = body.message.toolCalls[0].function?.arguments?.slug;
      } else if (body.message?.toolCallList?.[0]) {
        isVapiRequest = true;
        toolCallId = body.message.toolCallList[0].id;
        slug = body.message.toolCallList[0].function?.arguments?.slug || 
               body.message.toolCallList[0].arguments?.slug;
      }
      
      // If slug is the literal template string (AI didn't substitute), extract from variableValues
      if (!slug || slug === '{{propertySlug}}') {
        const variableValues = body.message?.call?.assistantOverrides?.variableValues;
        if (variableValues?.propertySlug) {
          slug = variableValues.propertySlug;
          console.log('Extracted slug from variableValues:', slug);
        }
      }
      
      // Fallback: check for direct slug in body (for non-Vapi requests)
      if (!slug || slug === '{{propertySlug}}') {
        slug = body.slug || body.propertySlug;
      }
    } else {
      // Handle regular GET requests
      slug = event.queryStringParameters?.slug;
    }

    console.log(`isVapiRequest: ${isVapiRequest}, toolCallId: ${toolCallId}, slug: ${slug}`);

    if (!slug) {
      const errorMsg = 'Missing property slug. Please provide the property slug.';
      if (isVapiRequest) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            results: [{ toolCallId: toolCallId || 'unknown', result: errorMsg }]
          })
        };
      }
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: errorMsg })
      };
    }

    console.log(`Fetching property info for slug: ${slug}`);

    // =========================================================================
    // STEP 1: Fetch the property by slug
    // =========================================================================
    const propertyRecords = await fetchTableRecords(
      CONFIG.TABLES.properties,
      `{slug} = '${slug}'`,
      1
    );

    if (propertyRecords.length === 0) {
      const errorMsg = `Property not found: ${slug}. Please check the property slug.`;
      if (isVapiRequest) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            results: [{ toolCallId: toolCallId || 'unknown', result: errorMsg }]
          })
        };
      }
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: errorMsg })
      };
    }

    const property = propertyRecords[0];
    console.log(`Found property: ${property.property_name || property.Name || property.name}`);
    console.log('Property fields available:', Object.keys(property));

    // =========================================================================
    // STEP 2: Determine the region
    // =========================================================================
    const region = resolveRegion(property.Region, property.zone);
    const regionTables = getRegionTables(region);
    console.log(`Resolved region: ${region}`);

    // =========================================================================
    // STEP 3: Fetch the property management group (if linked)
    // =========================================================================
    let propertyGroup = null;
    
    if (property['Property Management Groups']) {
      const groupLink = Array.isArray(property['Property Management Groups']) 
        ? property['Property Management Groups'][0] 
        : property['Property Management Groups'];
      
      try {
        if (groupLink.startsWith('rec')) {
          propertyGroup = await fetchRecordById(CONFIG.TABLES.propertyGroups, groupLink);
        } else {
          const groupRecords = await fetchTableRecords(
            CONFIG.TABLES.propertyGroups,
            `{group_name} = '${groupLink}'`,
            1
          );
          if (groupRecords.length > 0) {
            propertyGroup = groupRecords[0];
          }
        }
      } catch (err) {
        console.log('Could not fetch property group:', err.message);
      }
    }

    // =========================================================================
    // STEP 4: Fetch region-specific data
    // =========================================================================
    let restaurants = [];
    if (regionTables.restaurants) {
      restaurants = await fetchTableRecords(regionTables.restaurants);
      console.log(`Fetched ${restaurants.length} restaurants`);
    }

    let thingsToDo = [];
    if (regionTables.thingsToDo) {
      thingsToDo = await fetchTableRecords(regionTables.thingsToDo);
      console.log(`Fetched ${thingsToDo.length} activities`);
    }

    let groceries = [];
    if (regionTables.groceries) {
      groceries = await fetchTableRecords(regionTables.groceries);
      console.log(`Fetched ${groceries.length} grocery stores`);
    }

    // 30A-specific tables
    let dogFriendlyPlaces = [];
    let beaches = [];
    let rentalsAndServices = [];
    let fitnessAndWellness = [];
    let shopping = [];
    let rainyDay = [];
    let farmersMarkets = [];
    let groceryAndEssentials = [];

    if (region === '30A') {
      if (regionTables.dogFriendlyPlaces) {
        dogFriendlyPlaces = await fetchTableRecords(regionTables.dogFriendlyPlaces);
      }
      if (regionTables.beaches) {
        beaches = await fetchTableRecords(regionTables.beaches);
      }
      if (regionTables.rentalsAndServices) {
        rentalsAndServices = await fetchTableRecords(regionTables.rentalsAndServices);
      }
      if (regionTables.fitnessAndWellness) {
        fitnessAndWellness = await fetchTableRecords(regionTables.fitnessAndWellness);
      }
      if (regionTables.shopping) {
        shopping = await fetchTableRecords(regionTables.shopping);
      }
      if (regionTables.rainyDay) {
        rainyDay = await fetchTableRecords(regionTables.rainyDay);
      }
      if (regionTables.farmersMarkets) {
        farmersMarkets = await fetchTableRecords(regionTables.farmersMarkets);
      }
      if (regionTables.groceryAndEssentials) {
        groceryAndEssentials = await fetchTableRecords(regionTables.groceryAndEssentials);
      }
    }

    // =========================================================================
    // STEP 5: Build the response
    // =========================================================================
    const response = {
      success: true,
      region: region,
      
      property: {
        name: property.property_name || property.Name || property.name,
        slug: property.slug,
        region: region,
        area: property.Area,
        zone: property.zone,
        address: property.address,
        directions: property.directions,
        latitude: property.Latitude,
        longitude: property.Longitude,
        
        checkin_time: property.checkin_time,
        checkout_time: property.checkout_time,
        checkin_instructions: property.checkin_instructions,
        checkout_instructions: property.checkout_instructions,
        
        wifi_name: property.wifi_name,
        wifi_password: property.wifi_password,
        door_code: property.door_code,
        tv_info: property.tv_info,
        parking_info: property.parking_info,
        trash_info: property.trash_info,
        grill_info: property.grill_info,
        pool_info: property.pool_info,
        hot_tub_info: property.hot_tub_info,
        beach_info: property.beach_info,
        pets_allowed: property.pets_allowed,
        
        porch_lights: property.porch_lights,
        hummingbird_feeder: property.hummingbird_feeder,
        wood_burning_stove: property.wood_burning_stove,
        fire_safety: property.fire_safety,
        
        emergency_contact: property.emergency_contact,
        property_manager_name: property.property_manager_name,
        property_manager_phone: property.property_manager_phone,
      },
      
      propertyGroup: propertyGroup ? {
        name: propertyGroup.group_name,
        region: propertyGroup.Region,
        pm_company: propertyGroup.pm_company_name,
        pm_contact_name: propertyGroup.pm_contact_name,
        pm_contact_phone: propertyGroup.pm_contact_phone,
        pm_contact_email: propertyGroup.pm_contact_email,
        logo: propertyGroup.logo || propertyGroup.Logo || null,
        
        standard_checkin_time: propertyGroup.standard_checkin_time,
        standard_checkout_time: propertyGroup.standard_checkout_time,
        standard_checkin_instructions: propertyGroup.standard_checkin_instructions,
        standard_checkout_instructions: propertyGroup.standard_checkout_instructions,
        
        welcome_message: propertyGroup.welcome_message,
        house_rules: propertyGroup.house_rules,
        whats_included: propertyGroup.whats_included,
        cleaning_supplies: propertyGroup.cleaning_supplies,
        beach_gear: propertyGroup.beach_gear,
        house_bikes: propertyGroup.house_bikes,
        beach_access: propertyGroup.beach_access,
        emergency_contact: propertyGroup.emergency_contact,
        quiet_hours: propertyGroup.standard_quiet_hours,
      } : null,
      
      restaurants,
      thingsToDo,
      groceries,
      dogFriendlyPlaces,
      beaches,
      rentalsAndServices,
      fitnessAndWellness,
      shopping,
      rainyDay,
      farmersMarkets,
      groceryAndEssentials,
    };

    // If Vapi request, format as readable text for voice assistant
    if (isVapiRequest) {
      const p = response.property;
      const pg = response.propertyGroup;
      
      let resultText = `Property: ${p.name}
Location: ${p.area || 'Not specified'}
Address: ${p.address || 'Not provided'}

Check-in: ${p.checkin_time || pg?.standard_checkin_time || '4:00 PM'}
Check-out: ${p.checkout_time || pg?.standard_checkout_time || '10:00 AM'}

WiFi Network: ${p.wifi_name || 'Not provided'}
WiFi Password: ${p.wifi_password || 'Not provided'}
Door Code: ${p.door_code || 'Contact property manager'}

${p.checkin_instructions ? `Check-in Instructions: ${p.checkin_instructions}` : ''}
${p.checkout_instructions ? `Check-out Instructions: ${p.checkout_instructions}` : ''}
${p.parking_info ? `Parking: ${p.parking_info}` : ''}
${p.trash_info ? `Trash: ${p.trash_info}` : ''}
${p.beach_info ? `Beach Info: ${p.beach_info}` : ''}
${p.pool_info ? `Pool: ${p.pool_info}` : ''}
${p.grill_info ? `Grill: ${p.grill_info}` : ''}
${p.tv_info ? `TV: ${p.tv_info}` : ''}

Property Manager: ${pg?.pm_contact_name || p.property_manager_name || 'Not provided'}
PM Phone: ${pg?.pm_contact_phone || p.property_manager_phone || 'Not provided'}
`;

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
    }

    // For browser/API requests, return full JSON
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Error in getPropertyInfo:', error);
    
    // For any error, return in Vapi-compatible format (safest approach)
    // This works for both Vapi and browser requests
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        results: [{
          toolCallId: 'error',
          result: `Error fetching property info: ${error.message}`
        }],
        error: 'Internal server error', 
        message: error.message 
      })
    };
  }
};
