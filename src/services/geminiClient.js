import fetch from 'node-fetch';
import { config, assertGeminiConfigured } from '../config.js';

const GEMINI_API_KEY = config.gemini.apiKey;
const BASE_URL = config.gemini.baseUrl;

/**
 * Turns one freeform spoken sentence (already transcribed to text by the
 * app's on-device STT or /api/voice/stt) into a structured JSON object,
 * using Gemini's structured-output mode (responseSchema).
 *
 * This is what powers the "speak all your details at once and we fill the
 * form" flow: the user says something like
 *   "mera naam Ramesh hai, income pandrah hazaar hai, phone number ..."
 * and we ask Gemini to pull out only the fields the caller asked for.
 */
export async function extractFieldsFromTranscript({ transcript, languageCode, fields }) {
  assertGeminiConfigured();
  const properties = {};
  fields.forEach((f) => {
    properties[f.key] = {
      type: 'string',
      description: `${f.label}${f.type ? ` (${f.type})` : ''}`,
    };
  });

  const schema = {
    type: 'object',
    properties,
  };

  // System message: the extraction rules, held constant regardless of which
  // fields the caller asked for or what any one transcript contains.
  const systemInstruction = `You are a precise data extraction engine embedded in a rural business-loan app used by low-literacy users across India who fill forms by speaking instead of typing.

Your task is to process a raw, spoken-word transcript (language: ${languageCode || 'unknown, likely Hindi/Marathi/English mix'}) and map the entities directly into the provided JSON schema.

Follow these strict extraction rules:
1. No Hallucinations: Extract a value ONLY if it is clearly stated or clearly implied in the transcript. If a field is not mentioned at all, omit its key from the JSON entirely — never guess or invent a name, amount, or number.
2. Number Normalization: Numbers (income, debt, phone, Aadhaar, amounts) must be returned as plain digit strings only — no commas, no currency symbols, no words. Convert spoken number words/units to digits, e.g. "das hazaar" / "दस हज़ार" -> "10000", "paanch lakh" -> "500000".
3. Identity Numbers: Phone numbers and Aadhaar numbers must be digits only, no spaces or separators.
4. Data Standardization: Names/text fields should be returned in clean, readable form with proper capitalization where relevant.
5. Ignore Spoken Filler: Discard verbal stumbles (um, ah, like), conversational pleasantries, and irrelevant tangents when distilling a field's value.

Output nothing except the JSON object matching the schema — no prose, no markdown, no explanation.`;

  const prompt = `Extract values ONLY for the fields listed below, from the transcript given, and ONLY if that field is clearly stated or clearly implied:
${fields.map((f) => `- ${f.key}: ${f.label}`).join('\n')}

<transcript>
${transcript}
</transcript>`;

  const res = await fetch(`${BASE_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new GeminiApiError(res.status, data);
  }

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    throw new GeminiApiError(502, { message: 'No content returned from Gemini', data });
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new GeminiApiError(502, { message: 'Gemini returned invalid JSON', raw });
  }
}

export class GeminiApiError extends Error {
  constructor(status, body) {
    super(`Gemini request failed with status ${status}: ${JSON.stringify(body)}`);
    this.name = 'GeminiApiError';
    this.status = status;
    this.body = body;
  }
}
