import express from 'express';
import { clientIp, detectLocaleFromIp, parseBrowserLanguage } from '../utils/locale-geo.js';

const router = express.Router();

/**
 * GET /locale/detect — suggest language + currency from client IP (geoip-lite).
 * Public; no auth. Frontend uses this for first-visit language prompt.
 */
router.get('/detect', (req, res) => {
  try {
    const ip = clientIp(req);
    const geo = detectLocaleFromIp(ip);
    const browserLanguage = parseBrowserLanguage(req.headers['accept-language']);
    const suggestedLanguage = browserLanguage || geo.language;

    res.json({
      successful: true,
      data: {
        ...geo,
        browserLanguage,
        suggestedLanguage,
      },
    });
  } catch (err) {
    console.error('Locale detect error:', err);
    res.json({
      successful: true,
      data: {
        country: null,
        countryName: null,
        language: 'en',
        currency: 'CAD',
        browserLanguage: parseBrowserLanguage(req.headers['accept-language']),
        suggestedLanguage: parseBrowserLanguage(req.headers['accept-language']) || 'en',
        source: 'fallback',
      },
    });
  }
});

export default router;
