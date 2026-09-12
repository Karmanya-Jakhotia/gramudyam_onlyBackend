import { Router } from 'express';
import { extractUserProfile, IntakeExtractionError } from '../services/intakeExtraction.js';
import { ConfigError } from '../config.js';

const router = Router();

/**
 * POST /api/v1/intake
 * Body: { transcript: string }
 *
 * Flow (Phase 1): raw transcript -> Gemini structured extraction ->
 * Pydantic-equivalent (Zod) validation -> UserProfile -> complete profile
 * OR follow-up question. See src/services/intakeExtraction.js.
 */
router.post('/', async (req, res) => {
  const { transcript } = req.body || {};
  if (typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(422).json({
      error: 'invalid_request',
      message: 'transcript is required and must be a non-empty string',
    });
  }

  try {
    const profile = await extractUserProfile(transcript);
    return res.json(profile);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Missing GEMINI_API_KEY: a controlled, sanitized error — never the
      // raw ConfigError message reaches the response body verbatim beyond
      // this fixed string, and the key itself is never logged.
      console.error('[intake/v1] Gemini not configured');
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Intake extraction is temporarily unavailable',
      });
    }
    if (error instanceof IntakeExtractionError) {
      console.error('[intake/v1]', error.message);
      return res.status(error.status || 502).json({
        error: 'intake_extraction_failed',
        message: 'Could not extract a profile from the transcript. Please try again.',
      });
    }
    console.error('[intake/v1] unexpected error', error);
    return res.status(500).json({ error: 'internal_error', message: 'Unexpected server error' });
  }
});

export default router;
