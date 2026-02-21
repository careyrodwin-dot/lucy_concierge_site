// netlify/functions/get-analytics.js
// Fetches analytics data from Airtable for dashboard and reports

exports.handler = async (event, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const { property_slug, start_date, end_date, report_type } = params;

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const TABLE_NAME = 'Lucy Analytics';

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return { 
        statusCode: 500, 
        headers, 
        body: JSON.stringify({ success: false, error: 'Database not configured' }) 
      };
    }

    // Build filter formula
    let filterParts = [];
    
    if (property_slug && property_slug !== 'all') {
      filterParts.push(`{property_slug}="${property_slug}"`);
    }
    
    // Use inclusive date comparisons (IS_SAME OR IS_AFTER/IS_BEFORE)
    if (start_date) {
      filterParts.push(`OR(IS_SAME({date},"${start_date}","day"),IS_AFTER({date},"${start_date}"))`);
    }
    
    if (end_date) {
      filterParts.push(`OR(IS_SAME({date},"${end_date}","day"),IS_BEFORE({date},"${end_date}"))`);
    }

    const filterFormula = filterParts.length > 0 
      ? `AND(${filterParts.join(',')})`
      : '';

    // Fetch all records from Airtable (with pagination)
    let allRecords = [];
    let offset = null;

    do {
      let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_NAME)}?pageSize=100`;
      if (filterFormula) {
        url += `&filterByFormula=${encodeURIComponent(filterFormula)}`;
      }
      if (offset) {
        url += `&offset=${offset}`;
      }

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`
        }
      });

      const data = await response.json();
      
      if (data.error) {
        console.error('Airtable error:', data.error);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ success: false, error: data.error.message || 'Airtable error' })
        };
      }

      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
    } while (offset);

    // Process based on report type
    if (report_type === 'monthly') {
      const records = allRecords.map(r => r.fields);
      const report = generateMonthlyReport(records);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, report, record_count: allRecords.length })
      };
    }

    // Default: summary
    const summary = processSummaryStats(allRecords);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, summary, record_count: allRecords.length })
    };

  } catch (error) {
    console.error('Analytics error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false,
        error: error.message || 'Failed to fetch analytics' 
      })
    };
  }
};

function processSummaryStats(records) {
  const stats = {
    app_opens: 0,
    category_clicks: 0,
    card_clicks: 0,
    voice_calls: 0,
    quick_access: 0,
    unique_sessions: new Set(),
    by_category: {},
    by_property: {},
    peak_hours: {},
    top_recommendations: {},
    by_business: {},
    beach_clicks: {},
    quick_access_breakdown: {},
    modal_opens: {}
  };

  for (const record of records) {
    const fields = record.fields;
    const eventType = fields.event_type;
    const eventDetail = fields.event_detail || '';
    const eventCategory = fields.event_category || 'unknown';
    const sessionId = fields.session_id;
    const timestamp = fields.timestamp;
    const propertySlug = fields.property_slug || 'unknown';

    // Count by type
    if (eventType === 'app_open') stats.app_opens++;
    else if (eventType === 'category_click') stats.category_clicks++;
    else if (eventType === 'card_click') stats.card_clicks++;
    else if (eventType === 'voice_call') stats.voice_calls++;
    else if (eventType === 'quick_access') {
      stats.quick_access++;
      if (eventDetail) {
        // Beach-related quick access items go to beach_clicks
        if (eventCategory === 'beach') {
          stats.beach_clicks[eventDetail] = (stats.beach_clicks[eventDetail] || 0) + 1;
        } else {
          // All other quick access items
          stats.quick_access_breakdown[eventDetail] = (stats.quick_access_breakdown[eventDetail] || 0) + 1;
        }
      }
    }
    else if (eventType === 'modal_open') {
      if (eventDetail) {
        stats.modal_opens[eventDetail] = (stats.modal_opens[eventDetail] || 0) + 1;
      }
    }
    else if (eventType === 'impression') {
      if (eventDetail) {
        if (!stats.by_business[eventDetail]) {
          stats.by_business[eventDetail] = { 
            name: eventDetail, 
            category: eventCategory,
            impressions: 0, 
            clicks: 0 
          };
        }
        stats.by_business[eventDetail].impressions++;
      }
    }

    // Track clicks per business
    if (eventType === 'card_click' && eventDetail) {
      if (!stats.by_business[eventDetail]) {
        stats.by_business[eventDetail] = { 
          name: eventDetail, 
          category: eventCategory,
          impressions: 0, 
          clicks: 0 
        };
      }
      stats.by_business[eventDetail].clicks++;
    }

    // Unique sessions
    if (sessionId) stats.unique_sessions.add(sessionId);

    // By category
    if (eventCategory && eventCategory !== 'unknown') {
      stats.by_category[eventCategory] = (stats.by_category[eventCategory] || 0) + 1;
    }

    // By property
    stats.by_property[propertySlug] = (stats.by_property[propertySlug] || 0) + 1;

    // Top recommendations (card clicks)
    if (eventType === 'card_click' && eventDetail) {
      stats.top_recommendations[eventDetail] = (stats.top_recommendations[eventDetail] || 0) + 1;
    }

    // Peak hours
    if (timestamp) {
      try {
        const hour = new Date(timestamp).getUTCHours();
        stats.peak_hours[hour] = (stats.peak_hours[hour] || 0) + 1;
      } catch (e) {}
    }
  }

  // Sort top recommendations
  const sortedRecs = Object.entries(stats.top_recommendations)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Sort top by category
  const topByCategory = {};
  for (const [name, data] of Object.entries(stats.by_business)) {
    const cat = data.category || 'unknown';
    if (!topByCategory[cat]) topByCategory[cat] = [];
    topByCategory[cat].push([name, data.clicks]);
  }
  for (const cat of Object.keys(topByCategory)) {
    topByCategory[cat].sort((a, b) => b[1] - a[1]);
  }

  // Voice calls: divide by 2 for start/end pairs
  const voiceCalls = Math.round(stats.voice_calls / 2);
  const questionsAnswered = voiceCalls + stats.card_clicks;
  const timeSavedMinutes = Math.round(questionsAnswered * 5);

  return {
    app_opens: stats.app_opens,
    category_clicks: stats.category_clicks,
    card_clicks: stats.card_clicks,
    voice_calls: voiceCalls,
    quick_access: stats.quick_access,
    questions_answered: questionsAnswered,
    time_saved_hours: (timeSavedMinutes / 60).toFixed(1),
    unique_sessions: stats.unique_sessions.size,
    by_category: stats.by_category,
    by_property: stats.by_property,
    peak_hours: stats.peak_hours,
    top_recommendations: sortedRecs,
    top_by_category: topByCategory,
    by_business: Object.values(stats.by_business),
    beach_clicks: stats.beach_clicks,
    quick_access_breakdown: stats.quick_access_breakdown,
    modal_opens: stats.modal_opens
  };
}

function generateMonthlyReport(records) {
  const byPropertyMonth = {};
  
  records.forEach(r => {
    const prop = r.property_slug || 'unknown';
    const date = r.date || '';
    const month = date.substring(0, 7);
    
    const key = `${prop}|${month}`;
    if (!byPropertyMonth[key]) {
      byPropertyMonth[key] = {
        property: prop,
        month: month,
        events: []
      };
    }
    byPropertyMonth[key].events.push(r);
  });
  
  return Object.values(byPropertyMonth).map(group => ({
    property: group.property,
    month: group.month,
    event_count: group.events.length
  }));
}
