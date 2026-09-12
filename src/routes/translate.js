import { Router } from 'express';
import { translateText, SarvamApiError } from '../services/sarvamClient.js';
import { ConfigError } from '../config.js';

const router = Router();

// POST /api/translate
// body: { input: string, source_language_code?: string, target_language_code: string, mode?: string }
router.post('/', async (req, res) => {
  const { input, source_language_code, target_language_code, mode } = req.body || {};

  if (!input || typeof input !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: '"input" (string) is required' });
  }
  if (!target_language_code) {
    return res.status(400).json({ error: 'invalid_request', message: '"target_language_code" is required, e.g. "hi-IN"' });
  }

  try {
    const result = await translateText({
      input,
      sourceLanguageCode: source_language_code || 'auto',
      targetLanguageCode: target_language_code,
      mode: mode || 'formal',
    });
    res.json({
      translated_text: result.translated_text,
      detected_source_language_code: result.source_language_code,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('[translate] Sarvam not configured');
      return res.status(503).json({ error: 'service_unavailable', message: 'Translation is temporarily unavailable' });
    }
    if (err instanceof SarvamApiError) {
      return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: 'upstream_error',
        message: err.message,
      });
    }
    console.error('[translate] unexpected error', err);
    res.status(500).json({ error: 'internal_error', message: 'Translation failed' });
  }
});

export default router;
