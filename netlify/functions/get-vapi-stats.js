// netlify/functions/get-vapi-stats.js
// Fetches call data from Vapi API and counts actual guest questions

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
    const VAPI_API_KEY = process.env.VAPI_API_KEY;
    const ASSISTANT_ID = 'cdab0107-f7af-4f5e-a0d0-66284c1ba287';

    if (!VAPI_API_KEY) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, error: 'VAPI_API_KEY not configured' })
      };
    }

    const params = event.queryStringParameters || {};
    const { start_date, end_date } = params;

    // Build Vapi API URL with filters
    let url = `https://api.vapi.ai/call?assistantId=${ASSISTANT_ID}&limit=100`;
    
    if (start_date) {
      url += `&createdAtGe=${encodeURIComponent(start_date + 'T00:00:00.000Z')}`;
    }
    if (end_date) {
      url += `&createdAtLe=${encodeURIComponent(end_date + 'T23:59:59.999Z')}`;
    }

    // Fetch calls from Vapi
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Vapi API error:', response.status, errorText);
      
      // If date filters cause 400, retry without them
      if (response.status === 400) {
        const retryUrl = `https://api.vapi.ai/call?assistantId=${ASSISTANT_ID}&limit=100`;
        const retryResponse = await fetch(retryUrl, {
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (retryResponse.ok) {
          const allCalls = await retryResponse.json();
          // Filter by date client-side
          const filteredCalls = allCalls.filter(call => {
            const callDate = call.createdAt?.split('T')[0];
            if (start_date && callDate < start_date) return false;
            if (end_date && callDate > end_date) return false;
            return true;
          });
          // Continue processing with filteredCalls (assigned to calls variable below)
          return processCallsAndReturn(filteredCalls, headers);
        }
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: false, error: `Vapi API error: ${response.status} - ${errorText}` })
        };
      }
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, error: `Vapi API error: ${response.status} - ${errorText}` })
      };
    }

    const calls = await response.json();
    return processCallsAndReturn(calls, headers);

  } catch (error) {
    console.error('Vapi stats error:', error);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      },
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};

function processCallsAndReturn(calls, headers) {
    let totalQuestions = 0;
    let totalCalls = 0;
    let totalDurationSeconds = 0;
    const callDetails = [];
    const voiceRecommendations = {}; // place name → count
    const topicsAsked = {}; // topic → count
    let questionsAnswered = 0;
    let questionsNotAnswered = 0;

    for (const call of calls) {
      // Only count completed calls
      if (call.status !== 'ended') continue;

      totalCalls++;

      // Count user messages (each user message = 1 question/interaction)
      const messages = call.messages || call.artifact?.messages || [];
      const userMessages = messages.filter(m => 
        m.role === 'user' && 
        m.message && 
        m.message.trim().length > 0
      );
      
      const questionsInCall = userMessages.length;
      totalQuestions += questionsInCall;

      // Calculate duration
      if (call.startedAt && call.endedAt) {
        const duration = (new Date(call.endedAt) - new Date(call.startedAt)) / 1000;
        totalDurationSeconds += duration;
      }

      // Helper: split combined names like "Shaka Sushi and cocktail bar, Diego's Burrito factory"
      function splitAndCount(rawName) {
        if (!rawName || typeof rawName !== 'string') return;
        const parts = rawName.split(/\s*,\s*|\s*;\s*/)
          .flatMap(part => {
            const andParts = part.split(/\s+and\s+/i);
            if (andParts.length === 2 && andParts[0].trim() && andParts[1].trim() && 
                /^[A-Z]/.test(andParts[1].trim())) {
              return andParts;
            }
            return [part];
          })
          .map(s => s.trim())
          .filter(s => s.length > 1);
        
        for (const name of parts) {
          voiceRecommendations[name] = (voiceRecommendations[name] || 0) + 1;
        }
      }

      // Extract structured outputs (recommended_places, topics_asked, question_answered)
      const structuredOutputs = call.artifact?.structuredOutputs || {};
      for (const outputId of Object.keys(structuredOutputs)) {
        const result = structuredOutputs[outputId]?.result;
        if (!result) continue;

        // Check for recommended places (array of objects with place_name or array of strings)
        if (result.place_name) {
          splitAndCount(result.place_name);
        } else if (Array.isArray(result)) {
          for (const item of result) {
            const name = typeof item === 'string' ? item : (item.place_name || item.name);
            splitAndCount(name);
          }
        }

        // Check for topics
        if (result.topic) {
          topicsAsked[result.topic] = (topicsAsked[result.topic] || 0) + 1;
        } else if (Array.isArray(result) && result.length > 0 && result[0].topic) {
          for (const item of result) {
            if (item.topic) {
              topicsAsked[item.topic] = (topicsAsked[item.topic] || 0) + 1;
            }
          }
        }

        // Check for question_answered boolean
        if (typeof result === 'boolean') {
          if (result) questionsAnswered++;
          else questionsNotAnswered++;
        }
      }

      // Also check legacy analysisPlan structured data
      const structuredData = call.analysis?.structuredData;
      if (structuredData) {
        if (Array.isArray(structuredData.recommended_places)) {
          for (const name of structuredData.recommended_places) {
            splitAndCount(name);
          }
        }
        if (Array.isArray(structuredData.topics_asked)) {
          for (const topic of structuredData.topics_asked) {
            if (topic) topicsAsked[topic] = (topicsAsked[topic] || 0) + 1;
          }
        }
        if (typeof structuredData.question_answered === 'boolean') {
          if (structuredData.question_answered) questionsAnswered++;
          else questionsNotAnswered++;
        }
      }

      // Store call summary
      callDetails.push({
        id: call.id,
        date: call.createdAt,
        questions: questionsInCall,
        duration_seconds: call.startedAt && call.endedAt 
          ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
          : 0,
        summary: call.analysis?.summary || null
      });
    }

    const avgQuestionsPerCall = totalCalls > 0 
      ? (totalQuestions / totalCalls).toFixed(1) 
      : 0;
    
    const avgDurationSeconds = totalCalls > 0 
      ? Math.round(totalDurationSeconds / totalCalls) 
      : 0;

    // Sort voice recommendations by count and filter out junk
    const junkNames = ['30a', 'a 30a', 'inlet beach', 'the dashboard', 'dashboard', '30a area', 'the beach'];
    const sortedVoiceRecs = Object.entries(voiceRecommendations)
      .filter(([name]) => {
        const lower = name.toLowerCase().trim();
        // Remove entries that are too short, are just area names, or are junk
        if (lower.length < 4) return false;
        if (junkNames.includes(lower)) return false;
        return true;
      })
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));

    const sortedTopics = Object.entries(topicsAsked)
      .sort((a, b) => b[1] - a[1])
      .map(([topic, count]) => ({ topic, count }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        stats: {
          total_calls: totalCalls,
          total_questions: totalQuestions,
          avg_questions_per_call: parseFloat(avgQuestionsPerCall),
          avg_call_duration_seconds: avgDurationSeconds,
          total_call_duration_minutes: Math.round(totalDurationSeconds / 60),
          questions_answered: questionsAnswered,
          questions_not_answered: questionsNotAnswered
        },
        voice_recommendations: sortedVoiceRecs,
        topics_asked: sortedTopics,
        calls: callDetails
      })
    };
}
