// netlify/functions/web-search.js
// Tavily web search for Lucy Concierge - Vapi compatible

exports.handler = async (event, context) => {
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
    let query = null;
    let location = null;

    // Parse the Vapi request body
    if (event.body) {
      const body = JSON.parse(event.body);
      
      let args = {};
      
      // Check toolCalls format (Vapi sometimes uses this)
      if (body.message?.toolCalls?.[0]) {
        toolCallId = body.message.toolCalls[0].id;
        args = body.message.toolCalls[0].function?.arguments || {};
      } 
      // Check toolCallList format (Vapi sometimes uses this)
      else if (body.message?.toolCallList?.[0]) {
        toolCallId = body.message.toolCallList[0].id;
        args = body.message.toolCallList[0].function?.arguments || 
               body.message.toolCallList[0].arguments || {};
      }
      
      query = args.query;
      location = args.location;
      
      // Fallback: check for direct properties in body
      if (!query) {
        query = body.query;
      }
      if (!location) {
        location = body.location;
      }
    }

    // Also check query params
    if (!query && event.queryStringParameters?.query) {
      query = event.queryStringParameters.query;
    }
    if (!location && event.queryStringParameters?.location) {
      location = event.queryStringParameters.location;
    }

    if (!query) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          results: [{
            toolCallId: toolCallId || "unknown",
            result: "Error: No search query provided."
          }]
        })
      };
    }

    // Add location context to query if provided
    const searchQuery = location ? `${query} ${location}` : query;

    // Tavily API configuration
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

    if (!TAVILY_API_KEY) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          results: [{
            toolCallId: toolCallId || "unknown",
            result: "Error: Search service not configured."
          }]
        })
      };
    }

    // Call Tavily API
    const tavilyResponse = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: searchQuery,
        search_depth: 'basic',
        max_results: 5
      })
    });

    if (!tavilyResponse.ok) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          results: [{
            toolCallId: toolCallId || "unknown",
            result: "Error: Could not complete web search. Please try again."
          }]
        })
      };
    }

    const tavilyData = await tavilyResponse.json();

    // Format the results for Lucy to read
    let resultText = '';
    
    // Include the AI-generated answer if available
    if (tavilyData.answer) {
      resultText = `Answer: ${tavilyData.answer}\n\n`;
    }

    // Add top search results
    if (tavilyData.results && tavilyData.results.length > 0) {
      resultText += 'Search Results:\n';
      tavilyData.results.slice(0, 3).forEach((result, index) => {
        resultText += `${index + 1}. ${result.title}: ${result.content}\n`;
      });
    }

    if (!resultText) {
      resultText = "No results found for that search.";
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        results: [{
          toolCallId: toolCallId || "unknown",
          result: resultText.trim()
        }]
      })
    };

  } catch (error) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        results: [{
          toolCallId: "unknown",
          result: `Error: ${error.message}`
        }]
      })
    };
  }
};
