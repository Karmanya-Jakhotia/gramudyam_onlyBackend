import fetch from 'node-fetch';
import { config, assertSarvamConfigured } from '../config.js';

const BASE_URL = config.sarvam.baseUrl;
const API_KEY = config.sarvam.apiKey;

function authHeaders(extra = {}) {
  return {
    'api-subscription-key': API_KEY,
    ...extra,
  };
}

/**
 * Text translation via Sarvam's Mayura/Sarvam-Translate models.
 * https://docs.sarvam.ai/api-reference/text/translate-text
 */
export async function translateText({
  input,
  sourceLanguageCode = 'auto',
  targetLanguageCode,
  mode = 'formal',
}) {
  assertSarvamConfigured();
  const res = await fetchWithTimeout(`${BASE_URL}/translate`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      input,
      source_language_code: sourceLanguageCode,
      target_language_code: targetLanguageCode,
      model: config.sarvam.translateModel,
      mode,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new SarvamApiError('translate', res.status, data);
  }
  return data; // { translated_text, source_language_code, ... }
}

/**
 * Speech-to-text via Sarvam's Saaras model.
 * Expects a multipart form with the audio file.
 * https://docs.sarvam.ai/api-reference/speech-to-text/transcribe
 */
export async function speechToText({ audioBuffer, filename, mimeType, languageHint }) {
  assertSarvamConfigured();
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType || 'audio/wav' });
  form.append('file', blob, filename || 'audio.wav');
  form.append('model', config.sarvam.sttModel);
  form.append('mode', 'transcribe');
  if (languageHint && languageHint !== 'unknown') {
    form.append('language_code', languageHint);
  }

  const res = await fetchWithTimeout(`${BASE_URL}/speech-to-text`, {
    method: 'POST',
    headers: authHeaders(), // do NOT set Content-Type manually; fetch sets the multipart boundary
    body: form,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new SarvamApiError('speech-to-text', res.status, data);
  }
  return data; // { transcript, language_code, ... }
}

/**
 * Text-to-speech via Sarvam's Bulbul model. Returns base64 audio which we
 * decode to a Buffer for the route to stream back to the app.
 * https://docs.sarvam.ai/api-reference/text-to-speech
 */
export async function textToSpeech({ text, targetLanguageCode, speaker }) {
  assertSarvamConfigured();
  const res = await fetchWithTimeout(`${BASE_URL}/text-to-speech`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      target_language_code: targetLanguageCode,
      model: config.sarvam.ttsModel,
      speaker: speaker || config.sarvam.ttsSpeaker,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new SarvamApiError('text-to-speech', res.status, data);
  }
  // Sarvam returns { audios: ["<base64 wav>", ...] } for batch TTS
  const base64Audio = data.audios?.[0];
  if (!base64Audio) {
    throw new SarvamApiError('text-to-speech', 502, { message: 'No audio returned', data });
  }
  return Buffer.from(base64Audio, 'base64');
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new SarvamApiError('request-timeout', 504, { message: `Sarvam request timed out after ${timeoutMs}ms` });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export class SarvamApiError extends Error {
  constructor(endpoint, status, body) {
    super(`Sarvam ${endpoint} failed with status ${status}: ${JSON.stringify(body)}`);
    this.name = 'SarvamApiError';
    this.status = status;
    this.body = body;
  }
}
