import { Router } from 'express';
import { redactAadhaar } from '../services/intakeSchemas.js';
import { extractPageOne, extractPageTwo } from '../services/intakeService.js';
import { extractStructuredIntake } from '../services/structuredIntake.js';
import { ConfigError } from '../config.js';

const router = Router();

router.post('/extract', async (req, res) => {
  const { sarvamTranscript } = req.body || {};
  const applicationId = applicationIdFor(req);
  if (typeof sarvamTranscript !== 'string' || !sarvamTranscript.trim() || !applicationId) {
    return res.status(400).json({ error: 'invalid_request', message: 'applicationId and sarvamTranscript are required' });
  }
  try {
    const data = await extractStructuredIntake(sarvamTranscript.trim());
    return res.json({ applicationId, ...data });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('[intake/extract] Gemini not configured');
      return res.status(503).json({ error: 'service_unavailable', message: 'Intake extraction is temporarily unavailable' });
    }
    console.error('[intake/extract]', error);
    return res.status(error.status || 502).json({ error: 'intake_extraction_failed', message: error.message });
  }
});

function applicationIdFor(req) {
  const id = req.body?.applicationId || req.get('x-application-id');
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

router.post('/page-one', async (req, res) => {
  const { sarvamTranscript } = req.body || {};
  const applicationId = applicationIdFor(req);
  if (typeof sarvamTranscript !== 'string' || !sarvamTranscript.trim() || !applicationId) {
    return res.status(400).json({ error: 'invalid_request', message: 'applicationId and sarvamTranscript are required' });
  }
  try {
    const data = await extractPageOne({ applicationId, transcript: sarvamTranscript.trim() });
    return res.json({ applicationId, ...data });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('[intake/page-one] Gemini not configured');
      return res.status(503).json({ error: 'service_unavailable', message: 'Intake extraction is temporarily unavailable' });
    }
    console.error('[intake/page-one]', error);
    return res.status(error.status || 502).json({ error: 'intake_extraction_failed', message: error.message });
  }
});

router.post('/page-two', async (req, res) => {
  const { sarvamTranscript } = req.body || {};
  const applicationId = applicationIdFor(req);
  if (typeof sarvamTranscript !== 'string' || !sarvamTranscript.trim() || !applicationId) {
    return res.status(400).json({ error: 'invalid_request', message: 'applicationId and sarvamTranscript are required' });
  }
  const { redacted, lastFour } = redactAadhaar(sarvamTranscript.trim());
  try {
    const data = await extractPageTwo({ applicationId, redactedTranscript: redacted, lastFour });
    return res.json({ applicationId, ...data });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('[intake/page-two] Gemini not configured');
      return res.status(503).json({ error: 'service_unavailable', message: 'Intake extraction is temporarily unavailable' });
    }
    console.error('[intake/page-two]', error);
    return res.status(error.status || 502).json({ error: 'intake_extraction_failed', message: error.message });
  }
});

export default router;
