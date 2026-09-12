import { Router } from 'express';
import { uploadAudio } from '../middleware/upload.js';
import { speechToText, textToSpeech, SarvamApiError } from '../services/sarvamClient.js';
import { extractFieldsFromTranscript, GeminiApiError } from '../services/geminiClient.js';
import { ConfigError } from '../config.js';

const router = Router();

// POST /api/voice/stt   (multipart/form-data: audio=<file>, language_code=<hi-IN|mr-IN|en-IN|unknown>)
router.post('/stt', uploadAudio.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'invalid_request', message: '"audio" file is required' });
  }
  const languageHint = req.body.language_code || 'unknown';

  try {
    const result = await speechToText({
      audioBuffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      languageHint,
    });
    res.json({
      transcript: result.transcript,
      language_code: result.language_code,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('[stt] Sarvam not configured');
      return res.status(503).json({ error: 'service_unavailable', message: 'Speech-to-text is temporarily unavailable' });
    }
    if (err instanceof SarvamApiError) {
      return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: 'upstream_error',
        message: err.message,
      });
    }
    console.error('[stt] unexpected error', err);
    res.status(500).json({ error: 'internal_error', message: 'Speech-to-text failed' });
  }
});

// POST /api/voice/tts   body: { text, target_language_code, speaker? }
router.post('/tts', async (req, res) => {
  const { text, target_language_code, speaker } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: '"text" (string) is required' });
  }
  if (!target_language_code) {
    return res.status(400).json({ error: 'invalid_request', message: '"target_language_code" is required, e.g. "mr-IN"' });
  }
  if (text.length > 2500) {
    return res.status(400).json({ error: 'invalid_request', message: 'text exceeds 2500 character limit per Sarvam TTS request' });
  }

  try {
    const audioBuffer = await textToSpeech({ text, targetLanguageCode: target_language_code, speaker });
    res.set('Content-Type', 'audio/wav');
    res.send(audioBuffer);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('[tts] Sarvam not configured');
      return res.status(503).json({ error: 'service_unavailable', message: 'Text-to-speech is temporarily unavailable' });
    }
    if (err instanceof SarvamApiError) {
      return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: 'upstream_error',
        message: err.message,
      });
    }
    console.error('[tts] unexpected error', err);
    res.status(500).json({ error: 'internal_error', message: 'Text-to-speech failed' });
  }
});

// POST /api/voice/extract
// body: { transcript, language_code, fields: [{ key, label, type? }] }
//
// Powers the "speak all your details in one go and we auto-fill the form"
// flow: the app transcribes the user's speech (on-device or via /stt above),
// then sends the raw sentence here along with the list of form fields it
// wants filled. Gemini parses the sentence and returns only the fields it
// found, which the app maps onto its text controllers.
router.post('/extract', async (req, res) => {
  const { transcript, language_code, fields } = req.body || {};

  if (!transcript || typeof transcript !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: '"transcript" (string) is required' });
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({
      error: 'invalid_request',
      message: '"fields" (non-empty array of { key, label } objects) is required',
    });
  }

  try {
    const data = await extractFieldsFromTranscript({
      transcript,
      languageCode: language_code,
      fields,
    });
    res.json({ data });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('[extract] Gemini not configured');
      return res.status(503).json({ error: 'service_unavailable', message: 'Field extraction is temporarily unavailable' });
    }
    if (err instanceof GeminiApiError) {
      return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: 'upstream_error',
        message: err.message,
      });
    }
    console.error('[extract] unexpected error', err);
    res.status(500).json({ error: 'internal_error', message: 'Field extraction failed' });
  }
});

export default router;
