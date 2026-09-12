import fetch from 'node-fetch';
import { config, assertGeminiConfigured, ConfigError } from '../config.js';
import { getMarketSnapshot, MarketDataError } from '../tools/market.js';
import { returnFinancialSummary, FinanceValidationError } from '../tools/finance.js';

/**
 * Phase 3 — Framework-Free Gemini Function-Calling Orchestrator.
 *
 * This is the core agentic loop:
 *
 *   UserProfile -> Gemini -> select tool -> Python/JS tool executes ->
 *   tool result -> Gemini -> next tool / final synthesis
 *
 * No agent framework is used — this is a plain loop around Gemini's native
 * function-calling REST API. Everything in this file is orchestration only:
 * it NEVER computes a financial number or a market figure itself. It only
 * decides which already-validated deterministic tool (Phase 2) to run and
 * feeds the result back to Gemini.
 *
 * Production controls implemented here (per the plan):
 *  - Tool allowlist: only names present in TOOL_EXECUTORS can ever run.
 *    A model-generated string that isn't in the allowlist is rejected and
 *    reported back to Gemini as a structured error — never eval'd, never
 *    dynamically dispatched.
 *  - Argument validation: every functionCall's arguments are checked
 *    against the tool's declared schema before the underlying Phase 2 tool
 *    ever sees them.
 *  - Loop protection: MAX_AGENT_STEPS caps the number of Gemini round
 *    trips. Exceeding it returns a controlled orchestration failure
 *    instead of looping forever.
 *  - Failure handling: a tool failure (bad args, upstream outage, a
 *    deterministic validation error) is turned into a structured
 *    functionResponse error and handed back to Gemini — it never crashes
 *    the orchestrator or the request, and it never causes a fabricated
 *    value to be substituted for the missing one.
 */

export class OrchestrationError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'OrchestrationError';
    this.status = 502;
    if (cause) this.cause = cause;
  }
}

/** Hard ceiling on Gemini round trips for a single orchestration run. */
export const MAX_AGENT_STEPS = 8;

// ---------------------------------------------------------------------
// Tool registry — the ONLY tools Gemini may invoke. Declarations are what
// Gemini sees (name/description/parameter schema); executors are the real
// Phase 2 functions. Both are keyed by the same name so the allowlist and
// the "what does Gemini think this does" description can never drift apart
// silently — adding a tool means adding to both in the same place.
// ---------------------------------------------------------------------

export const TOOL_DECLARATIONS = [
  {
    name: 'fetch_geospatial_market_data',
    description:
      'Fetches real-world local market data for the proposed business location: nearby competitor count and distance to the nearest competitor (OpenStreetMap), and average/min/max mandi (wholesale) price for a commodity if applicable (data.gov.in). Every field carries an "available" flag — treat unavailable data as missing, never as zero or as a typical value.',
    parameters: {
      type: 'OBJECT',
      properties: {
        latitude: { type: 'NUMBER', description: 'Latitude of the business location, if known.' },
        longitude: { type: 'NUMBER', description: 'Longitude of the business location, if known.' },
        businessCategory: {
          type: 'STRING',
          description: 'The proposed business, e.g. "dairy", "grocery shop", "tailoring".',
        },
        commodity: {
          type: 'STRING',
          description: 'Commodity name for a mandi price lookup, only if the business trades a specific agricultural commodity (e.g. "Onion", "Wheat").',
        },
        state: { type: 'STRING', description: 'State name, to narrow the mandi price lookup.' },
        district: { type: 'STRING', description: 'District name, to narrow the mandi price lookup.' },
      },
      required: [],
    },
  },
  {
    name: 'calculate_loan_bounds',
    description:
      'Deterministically calculates the applicant\'s maximum eligible project cost and maximum loan (Margin Capital = 10% of Project Cost; Loan = 90% of Project Cost), the applicable scheme, and the EMI on the maximum loan. This is the ONLY source of truth for these numbers — never estimate or recompute a loan-eligibility figure yourself.',
    parameters: {
      type: 'OBJECT',
      properties: {
        marginCapital: {
          type: 'NUMBER',
          description: "The applicant's own available capital (margin capital) in INR.",
        },
        businessCategory: {
          type: 'STRING',
          description: 'Optional applicant/scheme category (e.g. "women", "sc_st", "obc", "minority", "general"), if known.',
        },
      },
      required: ['marginCapital'],
    },
  },
];

/**
 * The allowlist itself. Gemini can only ever cause one of these two
 * functions to run — a functionCall for anything else is rejected in
 * `executeTool` before any code path resembling dynamic dispatch is
 * reached.
 */
const TOOL_EXECUTORS = {
  fetch_geospatial_market_data: (args, deps) => getMarketSnapshot(args, deps),
  calculate_loan_bounds: (args) =>
    returnFinancialSummary({
      marginCapital: args.marginCapital,
      businessCategory: args.businessCategory ?? null,
    }),
};

const TOOL_SCHEMA_BY_NAME = Object.fromEntries(TOOL_DECLARATIONS.map((t) => [t.name, t]));

const GEMINI_TYPE_CHECKS = {
  NUMBER: (v) => typeof v === 'number' && Number.isFinite(v),
  STRING: (v) => typeof v === 'string',
  BOOLEAN: (v) => typeof v === 'boolean',
  OBJECT: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
};

/**
 * Validates a functionCall's arguments against its declared parameter
 * schema — required fields present, provided fields the right type. This
 * runs BEFORE the Phase 2 tool is ever called, so a malformed call from
 * Gemini never even reaches the deterministic finance/market code; it also
 * catches malformed calls from any injected/test caller. Deeper business
 * validation (e.g. "marginCapital must be > 0") still lives in Phase 2's
 * tools and is handled separately in `executeTool`.
 */
export function validateToolArguments(name, args) {
  const schema = TOOL_SCHEMA_BY_NAME[name];
  if (!schema) {
    return { valid: false, reason: 'unknown_tool', message: `"${name}" is not a registered tool` };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, reason: 'invalid_arguments', message: 'Tool arguments must be an object' };
  }

  const { properties = {}, required = [] } = schema.parameters || {};

  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      return {
        valid: false,
        reason: 'invalid_arguments',
        message: `Missing required argument "${field}"`,
        field,
      };
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const propSchema = properties[key];
    if (!propSchema) {
      return {
        valid: false,
        reason: 'invalid_arguments',
        message: `Unexpected argument "${key}"`,
        field: key,
      };
    }
    const check = GEMINI_TYPE_CHECKS[propSchema.type];
    if (check && !check(value)) {
      return {
        valid: false,
        reason: 'invalid_arguments',
        message: `Argument "${key}" must be of type ${propSchema.type}`,
        field: key,
      };
    }
  }

  return { valid: true };
}

/**
 * Runs a single tool call end to end: allowlist check -> argument
 * validation -> execution -> structured result. NEVER throws — every
 * failure mode (unknown tool, bad arguments, a Phase 2 validation error, an
 * upstream/network error, or any other unexpected exception) is caught and
 * returned as `{ error: true, reason, message, field? }` so the caller can
 * hand it straight back to Gemini as a functionResponse without special
 * casing, and so one bad tool call can never crash the orchestrator or the
 * request.
 */
export async function executeTool(name, args, deps = {}) {
  const executor = TOOL_EXECUTORS[name];
  if (!executor) {
    return { error: true, reason: 'unknown_tool', message: `"${name}" is not a registered tool` };
  }

  const validation = validateToolArguments(name, args);
  if (!validation.valid) {
    return { error: true, reason: validation.reason, message: validation.message, field: validation.field };
  }

  try {
    const result = await executor(args, deps);
    return { error: false, result };
  } catch (error) {
    if (error instanceof FinanceValidationError || error instanceof MarketDataError) {
      return { error: true, reason: error.name, message: error.message, field: error.field };
    }
    if (error instanceof ConfigError) {
      return { error: true, reason: 'ConfigError', message: error.message };
    }
    // Any other unexpected error (e.g. a bug in a tool) — still never
    // crashes the loop. It's reported as a generic execution failure so
    // Gemini can decide to give up gracefully rather than the process
    // taking down the whole request.
    return { error: true, reason: 'tool_execution_error', message: error.message };
  }
}

// ---------------------------------------------------------------------
// System instruction — the production principle from the plan, expressed
// as the model's operating rules.
// ---------------------------------------------------------------------

const SYSTEM_INSTRUCTION = `You are the orchestration reasoning layer for GramUdyam, a rural Indian business-feasibility and micro-loan eligibility assistant.

You have exactly two tools available: fetch_geospatial_market_data and calculate_loan_bounds. Follow these rules strictly:
1. Financial formulas (project cost, loan eligibility, EMI, scheme selection) must ALWAYS come from calculate_loan_bounds. Never compute, estimate, or restate a different number for these yourself.
2. Market figures (competitor counts, mandi prices) must ALWAYS come from fetch_geospatial_market_data. Never invent a competitor count or a price.
3. You may call a tool more than once only if you are missing a piece of information you did not have before (e.g. a different commodity).
4. If a tool result has available:false or an error, treat that data as missing. Say so plainly rather than substituting a typical, average, or made-up value.
5. Once you have the information you need (or have determined it is unavailable), stop calling tools and produce a final plain-language synthesis that a low-literacy beneficiary can understand.
6. Never call a tool that is not in your tool list.`;

/**
 * Builds the initial user-turn prompt from the validated Phase 1
 * UserProfile plus any extra market context (e.g. geocoded coordinates)
 * the caller has available. This is intentionally just a plain-language
 * briefing — the deterministic facts still only ever come from the tools.
 */
export function buildOrchestratorPrompt(userProfile, marketContext = {}) {
  const location = [userProfile.village, userProfile.block, userProfile.district, userProfile.state]
    .filter(Boolean)
    .join(', ');

  const lines = [
    'A rural entrepreneur has provided the following profile. Use your tools to gather the real data you need, then produce a short, honest, plain-language feasibility synthesis.',
    '',
    `Location: ${location || 'unknown'}`,
    `Proposed business: ${userProfile.proposed_business ?? 'unknown'}`,
    `Available margin capital (INR): ${userProfile.available_capital ?? 'unknown'}`,
    `Preferred language: ${userProfile.language ?? 'unknown'}`,
  ];

  if (marketContext.latitude !== undefined && marketContext.longitude !== undefined) {
    lines.push(`Location coordinates: ${marketContext.latitude}, ${marketContext.longitude}`);
  }
  if (marketContext.commodity) {
    lines.push(`Relevant commodity for mandi pricing: ${marketContext.commodity}`);
  }

  return lines.join('\n');
}

/**
 * The real Gemini caller: one function-calling round trip. Returns the
 * model's turn as `{ role, parts }`, mirroring the shape Gemini's REST API
 * returns in `candidates[0].content`, so this can be swapped for an
 * injected fake in tests without changing the loop logic at all.
 */
async function callGemini(contents, { httpClient = fetch } = {}) {
  assertGeminiConfigured();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.gemini.timeoutMs);
  let res;
  try {
    res = await httpClient(`${config.gemini.baseUrl}?key=${config.gemini.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { role: 'system', parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        generationConfig: { temperature: 0 },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new OrchestrationError(`Gemini request timed out after ${config.gemini.timeoutMs}ms`, { cause: error });
    }
    throw new OrchestrationError('Gemini request failed', { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  const body = await res.json();
  if (!res.ok) {
    throw new OrchestrationError(`Gemini request failed (${res.status})`, { cause: body });
  }

  const content = body.candidates?.[0]?.content;
  if (!content || !Array.isArray(content.parts)) {
    throw new OrchestrationError('Gemini returned no usable content', { cause: body });
  }
  return { role: content.role || 'model', parts: content.parts };
}

/**
 * The Phase 3 orchestration loop.
 *
 * `geminiCaller(contents) -> Promise<{ role, parts }>` is injectable so
 * tests never touch the network — it defaults to the real Gemini call.
 * `toolDeps` is passed through to tool executors (e.g. an injected
 * `httpClient` for the market tool in tests).
 *
 * Returns:
 *   { status: 'complete', finalText, toolTrace, steps }
 *   { status: 'error', reason, message, toolTrace }
 *
 * The orchestrator itself never throws for orchestration-level failures
 * (unknown tools, bad arguments, tool failures, exceeding the step limit)
 * — those are all represented in the returned `status`/`reason`. It only
 * throws (surfaces geminiCaller's rejection) for a hard Gemini transport
 * failure, since retrying/handling that is the caller's (route's)
 * decision, matching the "Gemini unavailable -> return structured service
 * error" production rule.
 */
export async function runOrchestrator(userProfile, marketContext = {}, { geminiCaller = callGemini, toolDeps = {} } = {}) {
  const contents = [{ role: 'user', parts: [{ text: buildOrchestratorPrompt(userProfile, marketContext) }] }];
  const toolTrace = [];

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    const modelTurn = await geminiCaller(contents);
    contents.push({ role: modelTurn.role || 'model', parts: modelTurn.parts || [] });

    const functionCalls = (modelTurn.parts || [])
      .filter((part) => part.functionCall)
      .map((part) => part.functionCall);

    if (functionCalls.length === 0) {
      const finalText = (modelTurn.parts || [])
        .filter((part) => typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      return { status: 'complete', finalText, toolTrace, steps: step };
    }

    const responseParts = [];
    for (const call of functionCalls) {
      const outcome = await executeTool(call.name, call.args || {}, toolDeps);
      toolTrace.push({ tool: call.name, args: call.args || {}, success: !outcome.error, outcome });
      responseParts.push({
        functionResponse: {
          name: call.name,
          response: outcome.error
            ? { error: { reason: outcome.reason, message: outcome.message, field: outcome.field } }
            : { result: outcome.result },
        },
      });
    }
    contents.push({ role: 'function', parts: responseParts });
  }

  return {
    status: 'error',
    reason: 'max_steps_exceeded',
    message: `Orchestration did not terminate within ${MAX_AGENT_STEPS} steps`,
    toolTrace,
  };
}
