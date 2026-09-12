import 'dotenv/config';

/**
 * Single source of truth for environment configuration.
 *
 * Production rules this enforces:
 *  - Every env var is read in exactly one place (here), never scattered
 *    across service files with their own `process.env.X || 'default'`.
 *  - Missing *required* secrets are reported clearly at boot via
 *    `validateConfig()` instead of surfacing as a confusing failure deep
 *    inside a request handler.
 *  - The key values themselves are never logged — only whether they are
 *    present.
 *
 * Note on "required": GEMINI_API_KEY and SARVAM_API_KEY each power a
 * different, independent slice of the API (Gemini: intake extraction;
 * Sarvam: translate/STT/TTS). Missing one shouldn't take down the whole
 * process, since the other slice may still be fully usable. So boot does
 * not `process.exit()` on a missing key — it logs a loud warning, and the
 * routes that actually need that key refuse the individual request with a
 * controlled 503 (see `assertGeminiConfigured` below) instead of crashing
 * or silently returning fabricated data.
 */

function parseOrigins(raw) {
  return (raw || '*').split(',').map((o) => o.trim()).filter(Boolean);
}

function parseIntEnv(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = Object.freeze({
  port: parseIntEnv(process.env.PORT, 4000),
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),

  gemini: Object.freeze({
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    get baseUrl() {
      return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    },
    timeoutMs: parseIntEnv(process.env.GEMINI_TIMEOUT_MS, 15000),
  }),

  sarvam: Object.freeze({
    apiKey: process.env.SARVAM_API_KEY || null,
    baseUrl: process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai',
    translateModel: process.env.SARVAM_TRANSLATE_MODEL || 'mayura:v1',
    sttModel: process.env.SARVAM_STT_MODEL || 'saaras:v3',
    ttsModel: process.env.SARVAM_TTS_MODEL || 'bulbul:v3',
    ttsSpeaker: process.env.SARVAM_TTS_SPEAKER || 'anushka',
  }),

  market: Object.freeze({
    // Overpass (OpenStreetMap) — no API key required, but public instances
    // are rate-limited and occasionally overloaded; timeout + controlled
    // failure matter more here than for a keyed API.
    overpassBaseUrl: process.env.OVERPASS_BASE_URL || 'https://overpass-api.de/api/interpreter',
    overpassTimeoutMs: parseIntEnv(process.env.OVERPASS_TIMEOUT_MS, 10000),

    // data.gov.in "Current Daily Price of Various Commodities from Various
    // Markets (Mandi)" resource. The sample key works but is shared/rate
    // limited across every anonymous caller — get a free key at
    // https://data.gov.in for production use.
    mandiApiKey: process.env.DATA_GOV_API_KEY || null,
    mandiResourceId: process.env.DATA_GOV_MANDI_RESOURCE_ID || '9ef84268-d588-465a-a308-a864a43d0070',
    get mandiBaseUrl() {
      return `https://api.data.gov.in/resource/${this.mandiResourceId}`;
    },
    mandiTimeoutMs: parseIntEnv(process.env.DATA_GOV_TIMEOUT_MS, 10000),
  }),
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Call once at boot. Logs (does not throw) for missing optional-but-important
 * secrets, so one misconfigured integration doesn't take down the others.
 */
export function validateConfig() {
  const warnings = [];
  if (!config.gemini.apiKey) {
    warnings.push('GEMINI_API_KEY is not set — intake extraction (/api/v1/intake, /api/intake/*) will refuse requests until it is configured.');
  }
  if (!config.sarvam.apiKey) {
    warnings.push('SARVAM_API_KEY is not set — translate/STT/TTS routes will refuse requests until it is configured.');
  }
  if (!config.market.mandiApiKey) {
    warnings.push('DATA_GOV_API_KEY is not set — mandi price lookups will refuse requests until it is configured (competitor lookups via Overpass are unaffected).');
  }
  for (const w of warnings) {
    console.warn(`[config] ${w}`);
  }
  return warnings;
}

/** Throws a ConfigError (never logs the key itself) if Gemini isn't configured. */
export function assertGeminiConfigured() {
  if (!config.gemini.apiKey) {
    throw new ConfigError('GEMINI_API_KEY is not configured');
  }
}

/** Throws a ConfigError (never logs the key itself) if Sarvam isn't configured. */
export function assertSarvamConfigured() {
  if (!config.sarvam.apiKey) {
    throw new ConfigError('SARVAM_API_KEY is not configured');
  }
}

/** Throws a ConfigError if the data.gov.in mandi-price key isn't configured. */
export function assertMandiConfigured() {
  if (!config.market.mandiApiKey) {
    throw new ConfigError('DATA_GOV_API_KEY is not configured');
  }
}
