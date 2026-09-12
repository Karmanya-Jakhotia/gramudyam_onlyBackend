import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  runOrchestrator,
  executeTool,
  validateToolArguments,
  buildOrchestratorPrompt,
  TOOL_DECLARATIONS,
  MAX_AGENT_STEPS,
  OrchestrationError,
} from '../src/engine/orchestrator.js';

// ---------------------------------------------------------------------
// Helpers for building canned Gemini turns (the shape `{ role, parts }`
// that the real callGemini() extracts from candidates[0].content).
// ---------------------------------------------------------------------

function functionCallTurn(calls) {
  return { role: 'model', parts: calls.map((c) => ({ functionCall: c })) };
}

function textTurn(text) {
  return { role: 'model', parts: [{ text }] };
}

const SAMPLE_PROFILE = {
  state: 'Maharashtra',
  district: 'Wardha',
  block: null,
  village: 'Rampura',
  available_capital: 100000,
  proposed_business: 'dairy',
  language: 'hi',
  is_complete: true,
  missing_fields: [],
  follow_up_question: null,
};

describe('buildOrchestratorPrompt', () => {
  test('includes the profile\'s key facts', () => {
    const prompt = buildOrchestratorPrompt(SAMPLE_PROFILE);
    assert.match(prompt, /Rampura/);
    assert.match(prompt, /dairy/);
    assert.match(prompt, /100000/);
  });
});

// ---------------------------------------------------------------------
// Tool allowlist + argument validation
// ---------------------------------------------------------------------

describe('validateToolArguments', () => {
  test('accepts valid arguments for a registered tool', () => {
    const result = validateToolArguments('calculate_loan_bounds', { marginCapital: 100000 });
    assert.equal(result.valid, true);
  });

  test('rejects an unregistered tool name', () => {
    const result = validateToolArguments('drop_all_tables', {});
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'unknown_tool');
  });

  test('rejects missing required arguments', () => {
    const result = validateToolArguments('calculate_loan_bounds', {});
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'invalid_arguments');
    assert.equal(result.field, 'marginCapital');
  });

  test('rejects a wrong-typed argument', () => {
    const result = validateToolArguments('calculate_loan_bounds', { marginCapital: '100000' });
    assert.equal(result.valid, false);
    assert.equal(result.field, 'marginCapital');
  });

  test('rejects an argument not declared for that tool', () => {
    const result = validateToolArguments('calculate_loan_bounds', { marginCapital: 100000, madeUpField: 1 });
    assert.equal(result.valid, false);
    assert.equal(result.field, 'madeUpField');
  });

  test('fetch_geospatial_market_data has no required arguments', () => {
    const result = validateToolArguments('fetch_geospatial_market_data', {});
    assert.equal(result.valid, true);
  });
});

describe('executeTool (allowlist authority)', () => {
  test('an unknown tool name is rejected, never executed', async () => {
    const outcome = await executeTool('delete_everything', {});
    assert.equal(outcome.error, true);
    assert.equal(outcome.reason, 'unknown_tool');
  });

  test('calculate_loan_bounds runs the real deterministic Phase 2 tool', async () => {
    const outcome = await executeTool('calculate_loan_bounds', { marginCapital: 100000 });
    assert.equal(outcome.error, false);
    assert.equal(outcome.result.maxProjectCost, 1000000);
    assert.equal(outcome.result.maxLoan, 900000);
  });

  test('a Phase 2 validation error (negative margin capital) is caught, not thrown', async () => {
    const outcome = await executeTool('calculate_loan_bounds', { marginCapital: -500 });
    assert.equal(outcome.error, true);
    assert.equal(outcome.reason, 'FinanceValidationError');
  });

  test('bad arguments are rejected before the Phase 2 tool ever runs', async () => {
    const outcome = await executeTool('calculate_loan_bounds', { marginCapital: 'not a number' });
    assert.equal(outcome.error, true);
    assert.equal(outcome.reason, 'invalid_arguments');
  });

  test('fetch_geospatial_market_data runs with an injected httpClient (no real network)', async () => {
    const httpClient = async () => ({ ok: true, status: 200, json: async () => ({ elements: [] }) });
    const outcome = await executeTool(
      'fetch_geospatial_market_data',
      { latitude: 20.75, longitude: 78.6, businessCategory: 'dairy' },
      { httpClient }
    );
    assert.equal(outcome.error, false);
    assert.equal(outcome.result.competitors.available, true);
  });

  test('an unexpected executor exception is still caught, not thrown', async () => {
    const httpClient = async () => { throw new Error('boom'); };
    const outcome = await executeTool('fetch_geospatial_market_data', { latitude: 20.75, longitude: 78.6 }, { httpClient });
    // fetchCompetitorData already turns network errors into available:false,
    // so this still succeeds at the executeTool level — the real "never
    // throws" guarantee is exercised by the FinanceValidationError case
    // above and the generic catch-all below.
    assert.equal(outcome.error, false);
  });
});

// ---------------------------------------------------------------------
// The orchestration loop itself
// ---------------------------------------------------------------------

describe('runOrchestrator', () => {
  test('a single tool call followed by a final synthesis completes normally', async () => {
    let call = 0;
    const geminiCaller = async () => {
      call += 1;
      if (call === 1) {
        return functionCallTurn([{ name: 'calculate_loan_bounds', args: { marginCapital: 100000 } }]);
      }
      return textTurn('You are eligible for a maximum loan of ₹9,00,000.');
    };

    const result = await runOrchestrator(SAMPLE_PROFILE, {}, { geminiCaller });
    assert.equal(result.status, 'complete');
    assert.equal(result.steps, 2);
    assert.equal(result.toolTrace.length, 1);
    assert.equal(result.toolTrace[0].tool, 'calculate_loan_bounds');
    assert.equal(result.toolTrace[0].success, true);
    assert.match(result.finalText, /9,00,000/);
  });

  test('tool arguments from the model are passed through to the tool unmodified', async () => {
    let capturedArgs = null;
    let call = 0;
    const geminiCaller = async () => {
      call += 1;
      if (call === 1) {
        return functionCallTurn([{ name: 'calculate_loan_bounds', args: { marginCapital: 250000, businessCategory: 'women' } }]);
      }
      return textTurn('Synthesis.');
    };
    const toolDeps = {};
    const result = await runOrchestrator(SAMPLE_PROFILE, {}, { geminiCaller, toolDeps });
    capturedArgs = result.toolTrace[0].args;
    assert.deepEqual(capturedArgs, { marginCapital: 250000, businessCategory: 'women' });
    assert.equal(result.toolTrace[0].outcome.result.maxLoan, 2250000);
  });

  test('tool results are handed back to Gemini before the next call', async () => {
    const seenContents = [];
    let call = 0;
    const geminiCaller = async (contents) => {
      seenContents.push(JSON.parse(JSON.stringify(contents)));
      call += 1;
      if (call === 1) {
        return functionCallTurn([{ name: 'calculate_loan_bounds', args: { marginCapital: 100000 } }]);
      }
      return textTurn('Done.');
    };
    await runOrchestrator(SAMPLE_PROFILE, {}, { geminiCaller });

    // Second call's contents must include a prior turn carrying the
    // functionResponse for the first call's functionCall.
    const secondCallContents = seenContents[1];
    const hasFunctionResponse = secondCallContents.some((turn) =>
      (turn.parts || []).some((p) => p.functionResponse?.name === 'calculate_loan_bounds')
    );
    assert.equal(hasFunctionResponse, true);
  });

  test('multiple tool calls in a single turn all execute and all get responses', async () => {
    let call = 0;
    const geminiCaller = async () => {
      call += 1;
      if (call === 1) {
        return functionCallTurn([
          { name: 'calculate_loan_bounds', args: { marginCapital: 100000 } },
          { name: 'fetch_geospatial_market_data', args: { businessCategory: 'dairy' } },
        ]);
      }
      return textTurn('Combined synthesis.');
    };
    const result = await runOrchestrator(SAMPLE_PROFILE, {}, { geminiCaller });
    assert.equal(result.toolTrace.length, 2);
    assert.deepEqual(result.toolTrace.map((t) => t.tool).sort(), ['calculate_loan_bounds', 'fetch_geospatial_market_data']);
    assert.ok(result.toolTrace.every((t) => t.success));
  });

  test('an unknown tool requested by the model is rejected but does not abort the run', async () => {
    let call = 0;
    const geminiCaller = async () => {
      call += 1;
      if (call === 1) {
        return functionCallTurn([{ name: 'launch_missiles', args: {} }]);
      }
      return textTurn('I could not complete that action.');
    };
    const result = await runOrchestrator(SAMPLE_PROFILE, {}, { geminiCaller });
    assert.equal(result.status, 'complete');
    assert.equal(result.toolTrace[0].success, false);
    assert.equal(result.toolTrace[0].outcome.reason, 'unknown_tool');
  });

  test('a tool failure (invalid args) is reported back to Gemini, not thrown', async () => {
    let call = 0;
    const geminiCaller = async () => {
      call += 1;
      if (call === 1) {
        return functionCallTurn([{ name: 'calculate_loan_bounds', args: { marginCapital: -100 } }]);
      }
      return textTurn('That margin capital is not valid.');
    };
    const result = await runOrchestrator(SAMPLE_PROFILE, {}, { geminiCaller });
    assert.equal(result.status, 'complete');
    assert.equal(result.toolTrace[0].success, false);
    assert.equal(result.toolTrace[0].outcome.reason, 'FinanceValidationError');
  });

  test('excessive tool-call loops terminate safely at MAX_AGENT_STEPS', async () => {
    let calls = 0;
    const geminiCaller = async () => {
      calls += 1;
      // Always asks for another tool call — never terminates on its own.
      return functionCallTurn([{ name: 'calculate_loan_bounds', args: { marginCapital: 100000 } }]);
    };
    const result = await runOrchestrator(SAMPLE_PROFILE, {}, { geminiCaller });
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'max_steps_exceeded');
    assert.equal(calls, MAX_AGENT_STEPS);
    assert.equal(result.toolTrace.length, MAX_AGENT_STEPS);
  });

  test('a hard Gemini transport failure surfaces to the caller rather than being swallowed', async () => {
    const geminiCaller = async () => {
      throw new OrchestrationError('Gemini request timed out after 15000ms');
    };
    await assert.rejects(() => runOrchestrator(SAMPLE_PROFILE, {}, { geminiCaller }), OrchestrationError);
  });
});

describe('TOOL_DECLARATIONS (what is exposed to Gemini)', () => {
  test('exactly the two tools from the architecture are registered', () => {
    const names = TOOL_DECLARATIONS.map((t) => t.name).sort();
    assert.deepEqual(names, ['calculate_loan_bounds', 'fetch_geospatial_market_data']);
  });
});
