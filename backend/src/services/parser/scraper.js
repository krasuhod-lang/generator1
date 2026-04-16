const axios = require('axios');

/**
 * Scrape multiple competitor URLs in parallel.
 *
 * @param {string[]} urls – list of URLs to fetch
 * @param {number} [timeoutMs=20000] – per-request timeout in ms
 * @returns {Promise<Array<{url: string, content: string|null, error: string|null, timedOut: boolean}>>}
 */
async function scrapeCompetitors(urls, timeoutMs = 20000) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  const tasks = urls.map(async (url) => {
    try {
      const response = await axios.get(url, {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SEOGeniusBot/4.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
        maxRedirects: 3,
        responseType: 'text',
      });

      // Trim HTML to reasonable size (200KB)
      const content = typeof response.data === 'string'
        ? response.data.slice(0, 200000)
        : String(response.data).slice(0, 200000);

      return { url, content, error: null, timedOut: false };
    } catch (err) {
      const timedOut = err.code === 'ECONNABORTED' || err.message.includes('timeout');
      return { url, content: null, error: err.message, timedOut };
    }
  });

  return Promise.all(tasks);
}

module.exports = { scrapeCompetitors };
