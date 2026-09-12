import { z } from 'zod';

/**
 * Canonical structured representation of intake data (Phase 1).
 *
 * Fields, per the production plan:
 *   state, district, block, village, available_capital, proposed_business,
 *   language, is_complete, missing_fields, follow_up_question
 *
 * Design decision: `is_complete`, `missing_fields`, and `follow_up_question`
 * are computed deterministically in code (see intakeExtraction.js), never
 * trusted from Gemini's output directly. Gemini extracts raw facts; the
 * server decides what's missing. This avoids a model that both extracts a
 * field AND declares it missing, which would silently disagree with itself.
 *
 * REQUIRED_FIELDS is the practical minimum GramUdyam needs to run a
 * feasibility analysis. `state` and `block` are collected when available
 * but are not required to gate completeness — many callers will only give
 * village + district.
 */

export const SUPPORTED_LANGUAGES = ['hi', 'mr', 'en'];

export const REQUIRED_FIELDS = [
  'district',
  'village',
  'available_capital',
  'proposed_business',
  'language',
];

const LANGUAGE_ALIASES = {
  hi: 'hi', hindi: 'hi', 'hin': 'hi',
  mr: 'mr', marathi: 'mr', 'mar': 'mr',
  en: 'en', english: 'en', eng: 'en',
};

/** Normalizes free-form language text ("Hindi", "HI", "hindi ") to an ISO-ish code, or null if unrecognized. */
export function normalizeLanguage(raw) {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  return LANGUAGE_ALIASES[key] || null;
}

/** Trims a string field; empty string is treated as absent (null), not as "provided but blank". */
export function normalizeText(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Normalizes a capital amount. Negative values are treated as invalid
 * extraction (null), never silently clamped to zero or accepted as-is —
 * per the plan's "Capital cannot be negative" rule, an invalid number is
 * safer represented as "not provided" than as a wrong provided value.
 */
export function normalizeCapital(raw) {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

const missingFieldEnum = z.enum([
  'state', 'district', 'block', 'village',
  'available_capital', 'proposed_business', 'language',
]);

/**
 * The "raw extraction" shape Gemini is asked to produce — nullable facts
 * only, no derived completeness fields. Validated strictly; unexpected
 * shapes are rejected rather than coerced.
 */
export const rawExtractionSchema = z.object({
  state: z.string().nullable(),
  district: z.string().nullable(),
  block: z.string().nullable(),
  village: z.string().nullable(),
  available_capital: z.number().nullable(),
  proposed_business: z.string().nullable(),
  language: z.string().nullable(),
}).strict();

export const rawExtractionResponseSchema = {
  type: 'OBJECT',
  properties: {
    state: { type: 'STRING', nullable: true },
    district: { type: 'STRING', nullable: true },
    block: { type: 'STRING', nullable: true },
    village: { type: 'STRING', nullable: true },
    available_capital: { type: 'NUMBER', nullable: true },
    proposed_business: { type: 'STRING', nullable: true },
    language: { type: 'STRING', nullable: true },
  },
  required: ['state', 'district', 'block', 'village', 'available_capital', 'proposed_business', 'language'],
};

/** The final, server-computed UserProfile — the only shape returned to callers. */
export const userProfileSchema = z.object({
  state: z.string().min(1).nullable(),
  district: z.string().min(1).nullable(),
  block: z.string().min(1).nullable(),
  village: z.string().min(1).nullable(),
  available_capital: z.number().nonnegative().nullable(),
  proposed_business: z.string().min(1).nullable(),
  language: z.enum(SUPPORTED_LANGUAGES).nullable(),
  is_complete: z.boolean(),
  missing_fields: z.array(missingFieldEnum),
  follow_up_question: z.string().min(1).nullable(),
}).strict();

/** True if a normalized field value counts as "provided". */
function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Builds the final UserProfile from normalized raw fields. Deterministic —
 * no model involvement — so completeness logic is always predictable and
 * testable in isolation.
 */
export function buildUserProfile(normalized) {
  const missing_fields = REQUIRED_FIELDS.filter((f) => !isPresent(normalized[f]));
  const is_complete = missing_fields.length === 0;
  const follow_up_question = is_complete
    ? null
    : followUpQuestionFor(missing_fields[0], normalized.language);

  const profile = {
    state: normalized.state ?? null,
    district: normalized.district ?? null,
    block: normalized.block ?? null,
    village: normalized.village ?? null,
    available_capital: normalized.available_capital ?? null,
    proposed_business: normalized.proposed_business ?? null,
    language: normalized.language ?? null,
    is_complete,
    missing_fields,
    follow_up_question,
  };

  // Final safety net: reject rather than return a shape that doesn't match
  // the contract, even though we built it ourselves.
  return userProfileSchema.parse(profile);
}

const FOLLOW_UP_QUESTIONS = {
  district: {
    en: 'Which district are you in?',
    hi: 'aap kis jile mein hain?',
    mr: 'tumhi konatya jilhyat aahat?',
  },
  village: {
    en: 'Which village or town are you in?',
    hi: 'aapka gaon ya kasba kaunsa hai?',
    mr: 'tumche gaav kontay?',
  },
  available_capital: {
    en: 'How much of your own money (margin capital) can you put in?',
    hi: 'aap khud kitna paisa (margin capital) laga sakte hain?',
    mr: 'tumhi swataha kiti paise (margin capital) ghalu shakta?',
  },
  proposed_business: {
    en: 'What business would you like to start?',
    hi: 'aap kaunsa vyavsaay shuru karna chahte hain?',
    mr: 'tumhala konta vyavasay suru karaycha aahe?',
  },
  language: {
    en: 'Which language would you like to continue in — Hindi, Marathi, or English?',
    hi: 'aap kis bhasha mein aage badhna chahenge — Hindi, Marathi, ya English?',
    mr: 'tumhala konatya bhashet pudhe jaayche aahe — Hindi, Marathi, ki English?',
  },
};

/** One follow-up question at a time, in the caller's language when known, else English. */
export function followUpQuestionFor(missingField, language) {
  const set = FOLLOW_UP_QUESTIONS[missingField];
  if (!set) return null;
  return set[language] || set.en;
}
