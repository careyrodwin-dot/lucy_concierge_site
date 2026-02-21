// Netlify Function: get-property.js
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
    },
    'Park_City': {
      restaurants: 'Park City Dining',
      thingsToDo: 'Park City Events and Activities',
      groceries: 'Park City Grocery and Essentials',
      skiAndActivities: 'Park City Ski and Activities',
      transportation: 'Park City Transportation',
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
    if (zoneLower.includes('park-city') || zoneLower.includes('canyons') || zoneLower.includes('kimball') || zoneLower.includes('deer-valley') || zoneLower.includes('heber')) {
      return 'Park_City';
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
    
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      
      // Handle Vapi POST requests (nested in toolCalls)
      slug = body.message?.toolCalls?.[0]?.function?.arguments?.slug;
      
      // Fallback: check for direct slug in body (for non-Vapi requests)
      if (!slug) {
        slug = body.slug || body.propertySlug;
      }
      
      console.log('POST body received:', JSON.stringify(body, null, 2));
    } else {
      // Handle regular GET requests
      slug = event.queryStringParameters?.slug;
    }

    if (!slug) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing property slug' })
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
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: `Property not found: ${slug}` })
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
      zone: property.zone,  // Added for HTML compatibility
      
      property: {
        property_name: property.property_name || property.Name || property.name,
        name: property.property_name || property.Name || property.name,
        slug: property.slug,
        region: region,
        area: property.Area,
        zone: property.zone,
        address: property.address,
        directions: property.directions || property.Directions,
        latitude: property.Latitude,
        longitude: property.Longitude,
        
        checkin_time: property.checkin_time,
        checkout_time: property.checkout_time,
        checkin_instructions: property.checkin_instructions,
        checkout_instructions: property.checkout_instructions,
        
        wifi_name: property.wifi_name,
        wifi_password: property.wifi_password,
        door_code: property.door_code,
        door_code_inst: property.door_code_inst,
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
      
      pmGroup: propertyGroup ? {
        name: propertyGroup.group_name,
        region: propertyGroup.Region,
        zone: propertyGroup.zone,
        area: propertyGroup.area,
        pm_company: propertyGroup.pm_company_name,
        pm_contact_name: propertyGroup.pm_contact_name,
        pm_contact_phone: propertyGroup.pm_contact_phone,
        pm_contact_email: propertyGroup.pm_contact_email,
        logo: propertyGroup.logo,
        dashboard_section_title: propertyGroup.dashboard_section_title,
        conditions_link: propertyGroup.conditions_link,
        conditions_label: propertyGroup.conditions_label,
        property_type: propertyGroup.property_type,
        weather_lat: propertyGroup.weather_lat,
        weather_lon: propertyGroup.weather_lon,
        
        standard_checkin_time: propertyGroup.standard_checkin_time,
        standard_checkout_time: propertyGroup.standard_checkout_time,
        standard_checkin_instructions: propertyGroup.standard_checkin_instructions,
        standard_checkout_instructions: propertyGroup.standard_checkout_instructions,
        standard_trash_pickup: propertyGroup.standard_trash_pickup,
        standard_pool_rules: propertyGroup.standard_pool_rules,
        standard_quiet_hours: propertyGroup.standard_quiet_hours,
        
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Error in getPropertyInfo:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error', 
        message: error.message 
      })
    };
  }
};
