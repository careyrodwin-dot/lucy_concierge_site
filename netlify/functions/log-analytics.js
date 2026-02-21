// netlify/functions/log-analytics.js
// Logs user interactions to Airtable for reporting

exports.handler = async (event, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { 
      property_slug, 
      event_type, 
      event_detail, 
      event_category,
      user_agent,
      session_id,
      impressions
    } = body;

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const BASE_ID = process.env.AIRTABLE_BASE_ID;
    const TABLE_NAME = 'Lucy Analytics';

    if (!AIRTABLE_API_KEY) {
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ success: false, debug_error: 'AIRTABLE_API_KEY not set' }) 
      };
    }

    if (!BASE_ID) {
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ success: false, debug_error: 'AIRTABLE_BASE_ID not set' }) 
      };
    }

    const airtableUrl = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}`;

    // Handle batch impressions
    if (impressions && Array.isArray(impressions)) {
      const records = impressions.map(imp => ({
        fields: {
          property_slug: property_slug || 'unknown',
          event_type: 'impression',
          event_detail: imp.name || '',
          event_category: imp.category || '',
          timestamp: new Date().toISOString(),
          session_id: session_id || '',
          date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
        }
      }));

      const batches = [];
      for (let i = 0; i < records.length; i += 10) {
        batches.push(records.slice(i, i + 10));
      }

      for (const batch of batches) {
        const response = await fetch(airtableUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ records: batch })
        });

        const result = await response.json();
        if (result.error) {
          console.error('Airtable batch error:', result.error);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: false, debug_error: result.error.message || JSON.stringify(result.error) })
          };
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: `Logged ${impressions.length} impressions` })
      };
    }

    // Handle single event
    if (!property_slug || !event_type) {
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ success: false, debug_error: 'Missing required fields: property_slug, event_type' }) 
      };
    }

    const record = {
      fields: {
        property_slug: property_slug,
        event_type: event_type,
        event_detail: event_detail || '',
        event_category: event_category || '',
        timestamp: new Date().toISOString(),
        user_agent: user_agent || '',
        session_id: session_id || '',
        date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
      }
    };

    const response = await fetch(airtableUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(record)
    });

    const result = await response.json();

    if (result.error) {
      console.error('Airtable error:', result.error);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, debug_error: result.error.message || JSON.stringify(result.error) })
      };
    }

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ success: true, message: 'Event logged' }) 
    };

  } catch (e) {
    console.error('Analytics error:', e);
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ success: false, debug_error: e.message }) 
    };
  }
};
