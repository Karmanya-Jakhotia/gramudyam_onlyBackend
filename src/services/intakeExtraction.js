import fetch from 'node-fetch';
import { config, assertGeminiConfigured } from '../config.js';
import {
  rawExtractionSchema,
  rawExtractionResponseSchema,
  normalizeLanguage,
  normalizeText,
  normalizeCapital,
  buildUserProfile,
} from '../schemas/userProfile.js';

export class IntakeExtractionError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'IntakeExtractionError';
    this.status = 502;
    if (cause) this.cause = cause;
  }
}

const SYSTEM_INSTRUCTION = `You are a precise data extraction engine embedded in GramUdyam, a rural Indian business and micro-loan eligibility app. You process raw spoken-word transcripts (already converted from audio to text, possibly mixing Hindi, Marathi, Hinglish, and English) and extract facts about the speaker's location, business idea, and available capital.

Fields to extract:
- state: Indian state name
- district: district name
- block: block/taluka name
- village: village or town name
- available_capital: the speaker's OWN money they can put in (margin capital), as a plain numeric INR value — NOT a loan amount, NOT income, NOT debt
- proposed_business: a short, standard English description of the business idea (e.g. "dairy", "grocery shop", "tailoring")
- language: the dominant language of the transcript — one of "hindi", "marathi", "english"

Strict rules:
1. No Hallucinations: if a field is not explicitly stated or clearly implied, its value MUST be null. Never guess a location name or amount.
2. Number Normalization: convert spoken number expressions ("10 hazaar", "10k", "one lakh", "₹10,000") into a plain numeric value. Never confuse available_capital with income, debt, or loan amount — if the transcript only mentions income or a loan amount and not the speaker's own contribution, leave available_capital null.
3. Capitalize proper nouns (state/district/block/village names).
4. Discard filler words, pleasantries, and irrelevant tangents.
5. If a value is mentioned more than once, use the clearest and most recent statement.

Return ONLY valid JSON matching the response schema — no prose, no markdown, no explanation.`;

function buildPrompt(transcript) {
  return `Extract the required fields from the following spoken transcript:\n<transcript>\n${transcript}\n</transcript>`;
}

async function callGemini(prompt) {
  assertGeminiConfigured();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.gemini.timeoutMs);
  let res;
  try {
    res = await fetch(`${config.gemini.baseUrl}?key=${config.gemini.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { role: 'system', parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: rawExtractionResponseSchema,
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new IntakeExtractionError(`Gemini request timed out after ${config.gemini.timeoutMs}ms`, { cause: error });
    }
    throw new IntakeExtractionError('Gemini request failed', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.json();
  if (!res.ok) {
    throw new IntakeExtractionError(`Gemini request failed (${res.status})`, { cause: body });
  }
  const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    throw new IntakeExtractionError('Gemini returned no structured content');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new IntakeExtractionError('Gemini returned invalid JSON', { cause: error });
  }
}

function normalizeRaw(raw) {
  return {
    state: normalizeText(raw.state),
    district: normalizeText(raw.district),
    block: normalizeText(raw.block),
    village: normalizeText(raw.village),
    available_capital: normalizeCapital(raw.available_capital),
    proposed_business: normalizeText(raw.proposed_business),
    language: normalizeLanguage(raw.language),
  };
}

/**
 * Extracts a validated UserProfile from a raw transcript.
 *
 * `geminiCaller` is injectable so tests never need real network access —
 * it defaults to the real Gemini call and only needs overriding in tests.
 *
 * Flow: Gemini structured extraction -> Zod validation -> normalize ->
 * deterministic completeness computation -> final UserProfile.
 * On a schema mismatch, retries once with the validation error appended
 * (mirrors the existing structuredIntake.js pattern); if it still fails,
 * throws IntakeExtractionError rather than fabricating or guessing a
 * profile.
 */
export async function extractUserProfile(transcript, { geminiCaller = callGemini } = {}) {
  if (typeof transcript !== 'string' || !transcript.trim()) {
    throw new IntakeExtractionError('transcript must be a non-empty string');
  }

  const prompt = buildPrompt(transcript.trim());
  let candidate = await geminiCaller(prompt);
  let parsed = rawExtractionSchema.safeParse(candidate);

  if (!parsed.success) {
    const retryPrompt = `${prompt}\nThe previous response failed schema validation. Return ONLY the exact JSON schema, all seven fields present (use null for anything unknown). Validation error: ${JSON.stringify(parsed.error.issues)}`;
    candidate = await geminiCaller(retryPrompt);
    parsed = rawExtractionSchema.safeParse(candidate);
  }

  if (!parsed.success) {
    throw new IntakeExtractionError('Gemini response failed intake schema validation after retry', { cause: parsed.error });
  }

  const normalized = normalizeRaw(parsed.data);
  return buildUserProfile(normalized);
}
