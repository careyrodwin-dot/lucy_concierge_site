// netlify/functions/get-beach-conditions.js
// Fetches sunset time, weather, and beach flag info for 30A properties

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
    // Default to Inlet Beach coordinates
    const lat = event.queryStringParameters?.lat || '30.2819';
    const lon = event.queryStringParameters?.lon || '-86.0039';

    // Fetch sunset and weather in parallel
    const [sunsetData, weatherData] = await Promise.all([
      fetchSunset(lat, lon),
      fetchWeather(lat, lon)
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        sunset: sunsetData,
        weather: weatherData,
        beachFlags: {
          // No public API available - link to official source
          status: 'Check at beach',
          source: 'South Walton Fire District',
          url: 'https://www.swfd.org/beach-safety/',
          note: 'Flag conditions change throughout the day. Always check flags when you arrive at the beach.'
        },
        timestamp: new Date().toISOString()
      })
    };

  } catch (error) {
    console.error('Error fetching beach conditions:', error);
    return {
      statusCode: 200, // Return 200 with fallback data so page still works
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
        sunset: { time: 'Check locally', formatted: '--:-- PM' },
        weather: { temp: '--', condition: 'Check locally', icon: '🌤️' },
        beachFlags: {
          status: 'Check at beach',
          url: 'https://www.swfd.org/beach-safety/'
        }
      })
    };
  }
};

// Fetch sunset time from sunrise-sunset.org API (free, no key needed)
async function fetchSunset(lat, lon) {
  try {
    const response = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`
    );
    const data = await response.json();

    if (data.status === 'OK') {
      // The API returns UTC time - convert directly to Central Time string
      const sunsetUTC = new Date(data.results.sunset);
      
      // Format as "5:47 PM" in Central Time
      const formatted = sunsetUTC.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Chicago'
      });

      return {
        time: data.results.sunset,
        formatted: formatted,
        timezone: 'CT'
      };
    }
    
    return { time: null, formatted: 'N/A', error: 'API error' };
  } catch (error) {
    console.error('Sunset API error:', error);
    return { time: null, formatted: 'N/A', error: error.message };
  }
}

// Fetch weather from Weather.gov API (free, no key needed for US locations)
async function fetchWeather(lat, lon) {
  try {
    // First, get the forecast URL for this location
    const pointsResponse = await fetch(
      `https://api.weather.gov/points/${lat},${lon}`,
      {
        headers: {
          'User-Agent': 'LucyConcierge/1.0 (vacation rental assistant)',
          'Accept': 'application/json'
        }
      }
    );
    
    if (!pointsResponse.ok) {
      throw new Error('Could not get weather location');
    }
    
    const pointsData = await pointsResponse.json();
    const forecastUrl = pointsData.properties.forecast;
    const hourlyForecastUrl = pointsData.properties.forecastHourly;

    // Get hourly forecast for current conditions
    const hourlyResponse = await fetch(hourlyForecastUrl, {
      headers: {
        'User-Agent': 'LucyConcierge/1.0 (vacation rental assistant)',
        'Accept': 'application/json'
      }
    });

    if (!hourlyResponse.ok) {
      throw new Error('Could not get hourly forecast');
    }

    const hourlyData = await hourlyResponse.json();
    const currentPeriod = hourlyData.properties.periods[0];

    // Map weather conditions to emojis
    const weatherEmoji = getWeatherEmoji(currentPeriod.shortForecast);

    return {
      temp: currentPeriod.temperature,
      unit: currentPeriod.temperatureUnit,
      condition: currentPeriod.shortForecast,
      icon: weatherEmoji,
      humidity: currentPeriod.relativeHumidity?.value || null,
      windSpeed: currentPeriod.windSpeed,
      windDirection: currentPeriod.windDirection,
      formatted: `${currentPeriod.temperature}° ${simplifyCondition(currentPeriod.shortForecast)}`
    };

  } catch (error) {
    console.error('Weather API error:', error);
    return {
      temp: null,
      condition: 'Unable to load',
      icon: '🌤️',
      formatted: 'Check locally',
      error: error.message
    };
  }
}

// Map weather conditions to emojis
function getWeatherEmoji(condition) {
  const c = condition.toLowerCase();
  
  if (c.includes('thunder') || c.includes('storm')) return '⛈️';
  if (c.includes('rain') || c.includes('shower')) return '🌧️';
  if (c.includes('snow')) return '❄️';
  if (c.includes('cloud') && c.includes('sun')) return '⛅';
  if (c.includes('cloud') || c.includes('overcast')) return '☁️';
  if (c.includes('fog') || c.includes('mist')) return '🌫️';
  if (c.includes('clear') || c.includes('sunny')) return '☀️';
  if (c.includes('partly')) return '🌤️';
  if (c.includes('wind')) return '💨';
  
  return '🌤️'; // Default
}

// Simplify weather condition text
function simplifyCondition(condition) {
  const c = condition.toLowerCase();
  
  if (c.includes('thunder')) return 'Storms';
  if (c.includes('rain') || c.includes('shower')) return 'Rainy';
  if (c.includes('partly cloudy')) return 'Partly Cloudy';
  if (c.includes('mostly cloudy')) return 'Mostly Cloudy';
  if (c.includes('cloudy') || c.includes('overcast')) return 'Cloudy';
  if (c.includes('sunny') || c.includes('clear')) return 'Sunny';
  if (c.includes('fog')) return 'Foggy';
  
  // Return original if short enough, otherwise truncate
  return condition.length > 12 ? condition.substring(0, 12) + '...' : condition;
}
