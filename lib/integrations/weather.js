'use strict';

/**
 * lib/integrations/weather.js
 *
 * Today's forecast for Hamilton from the Open-Meteo API (no key). fetchWeather()
 * resolves null on any failure and never rejects, so a caller can drop the section.
 *
 * LOGIC CHANGE 2026-10-05: Moved unchanged out of morning-digest.js (WORK-TODO #10,
 * wave 2). It was private to that script, which has no exports, so nothing else could
 * call it; a `weather` command verb is now buildable (not registered by this move).
 */

const https = require('https');

// LOGIC CHANGE 2026-03-26: Added weather section to morning digest using Open-Meteo API
const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast?latitude=43.2557&longitude=-79.8711&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=America/Toronto&forecast_days=1';

/**
 * Decode WMO weather code to human-readable text
 * @param {number} code - WMO weather code
 * @returns {string} - Human-readable weather condition
 */
function decodeWeatherCode(code) {
    if (code === 0) return 'Clear';
    if (code >= 1 && code <= 3) return 'Partly cloudy';
    if (code >= 45 && code <= 48) return 'Fog';
    if (code >= 51 && code <= 55) return 'Drizzle';
    if (code >= 61 && code <= 65) return 'Rain';
    if (code >= 71 && code <= 75) return 'Snow';
    if (code >= 80 && code <= 82) return 'Showers';
    if (code === 95) return 'Thunderstorm';
    return 'Unknown';
}

/**
 * Fetch weather data from Open-Meteo API
 * @returns {Promise<{high: number, low: number, precipChance: number, conditions: string}|null>}
 */
function fetchWeather() {
    return new Promise((resolve) => {
        https.get(WEATHER_API_URL, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const daily = json.daily;
                    if (!daily) {
                        console.error('[morning-digest] Weather API returned no daily data');
                        resolve(null);
                        return;
                    }
                    resolve({
                        high: Math.round(daily.temperature_2m_max[0]),
                        low: Math.round(daily.temperature_2m_min[0]),
                        precipChance: daily.precipitation_probability_max[0],
                        conditions: decodeWeatherCode(daily.weathercode[0]),
                    });
                } catch (err) {
                    console.error('[morning-digest] Failed to parse weather data:', err.message);
                    resolve(null);
                }
            });
        }).on('error', (err) => {
            console.error('[morning-digest] Weather fetch failed:', err.message);
            resolve(null);
        });
    });
}

module.exports = {
    WEATHER_API_URL,
    decodeWeatherCode,
    fetchWeather,
};
