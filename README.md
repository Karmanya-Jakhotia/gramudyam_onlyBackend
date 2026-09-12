# GramUdyam Backend

Production-oriented Node.js/Express implementation of GramUdyam's 5-phase
architecture (see `GramUdyam_Production_5_Phase_Implementation.md` at the
repo root for the original plan). No agent framework — plain Express routes,
native Gemini function calling, and deterministic JS/Zod for anything
financial.

> **Gemini interprets and orchestrates; deterministic tools calculate and
> validate; external APIs provide real-world data; guardrails have final
> authority over financial recommendations.**

## Setup

```bash
cd backend
npm install
cp .env.example .env   # then fill in real keys — never commit .env
npm start               # or: npm run dev
```

Required/optional keys (see `.env.example` for details):

| Key | Powers |
|---|---|
| `GEMINI_API_KEY` | Intake extraction, orchestration, report narrative |
| `SARVAM_API_KEY` | Translate / STT / TTS |
| `DATA_GOV_API_KEY` | Mandi (wholesale) price lookups |

Missing a key doesn't crash the process — the routes that need it return a
controlled `503 service_unavailable` until it's configured.

## Tests

```bash
npm test              # everything
npm run test:phase1   # intake & UserProfile
npm run test:phase2   # market + finance tools
npm run test:phase3   # Gemini function-calling orchestrator
npm run test:phase4   # risk & stress-test guardrails
npm run test:phase5   # report assembly, scoring, PDF generation
```

## The 5 phases

1. **Foundation, Configuration & Intent Extraction** — `src/config.js`,
   `src/schemas/userProfile.js`, `src/routes/v1Intake.js`. Raw
   text/transcript → Gemini structured extraction → Zod validation →
   `UserProfile` (complete, or with a follow-up question).
2. **External Tool Suite** — `src/tools/market.js` (Overpass + data.gov.in,
   never fabricates data), `src/tools/finance.js` (deterministic loan
   eligibility/EMI math, unit-tested).
3. **Gemini Function-Calling Orchestrator** — `src/engine/orchestrator.js`.
   A tool allowlist, argument validation, an 8-step loop cap, and
   structured failure handling around native Gemini function calling.
4. **Deterministic Risk & Stress-Test Guardrails** — `src/engine/
   guardrails.js`. Stress-tests revenue/costs (-20%/+15%) and caps
   `recommended_safe_loan` at `max_eligible_loan`, always.
5. **Structured Report Generation & API Delivery** — `src/schemas/
   report.js`, `src/engine/scoring.js`, `src/services/reportNarrative.js`,
   `src/services/reportAssembly.js`, `src/services/pdfGenerator.js`.
   Combines Phases 1-4 into a validated `FeasibilityReport` plus a
   downloadable DPR PDF.

### Phase 5 design notes

- **`business_readiness_score` is deterministic**, not Gemini-authored —
  see `src/engine/scoring.js`. It's derived from Phase 4's risk
  classification plus market-data availability, for the same reason the
  safe loan figure is deterministic: a beneficiary-facing number shouldn't
  come from free-form model output.
- **Gemini is only ever asked for qualitative content** in Phase 5 — SWOT
  analysis, alternative business ideas, and a plain-language explanation
  (`src/services/reportNarrative.js`). It is handed the final numbers as
  read-only context and instructed never to restate them differently.
- **The DPR PDF generator has zero new runtime dependencies.**
  `src/services/pdfWriter.js` is a small, hand-written PDF (1.4) writer
  built directly on the format's object/xref/trailer structure and the
  standard 14 fonts, since this environment couldn't install a PDF
  library. It supports headings, paragraphs, bullet lists, a key/value
  table, and automatic page breaks. Known limitation: standard PDF fonts
  only cover the Latin-1-ish WinAnsi subset, so report content is
  produced in English/romanized form, not Devanagari script — see the
  comment at the top of `pdfWriter.js` for the full rationale and the
  upgrade path (embedding a Unicode font) if that's ever needed.

## Full API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness check |
| `POST /api/v1/intake` | Raw transcript → validated `UserProfile` |
| `POST /api/v1/analyze` | `UserProfile` → orchestrator → market/finance tools → guardrails → `FeasibilityReport` |
| `POST /api/v1/download-dpr` | `FeasibilityReport` → DPR PDF (binary, `application/pdf`) |
| `POST /api/intake/*`, `POST /api/report/generate` | Earlier/simpler intake and report endpoints kept for the existing Flutter screens |
| `POST /api/translate`, `POST /api/voice/*` | Sarvam AI translate/STT/TTS proxy |

### `POST /api/v1/analyze` — request body

```json
{
  "userProfile": { "...": "a complete UserProfile from /api/v1/intake" },
  "marketContext": { "latitude": 20.75, "longitude": 78.6, "commodity": "Onion" },
  "revenueAssumptions": { "sellingPrice": 50, "unitsPerDay": 20, "operatingDaysPerMonth": 26 },
  "costAssumptions": { "fixedCostsPerMonth": 5000, "variableCostPerUnit": 10 },
  "isEstimate": false
}
```

`revenueAssumptions`/`costAssumptions` are required and explicit, by
design — see the plan's Phase 4 note on never silently assuming
`price * 30 * 20`. Set `isEstimate: true` when these aren't verified local
data; it's carried through to the report's `warnings`.

### `POST /api/v1/download-dpr` — request body

```json
{ "report": { "...": "the exact object returned under `report` by /api/v1/analyze" } }
```

## Security & production notes

- Secrets are read in exactly one place (`src/config.js`) and never
  logged.
- Every external call (Gemini, Overpass, data.gov.in) has a timeout and a
  controlled failure path — a bad/slow upstream never crashes the process
  and never causes a fabricated number to be substituted for missing data.
- Financial and risk rules are centralized in `src/config/schemeRules.js`,
  `src/config/guardrailRules.js`, and `src/config/scoringRules.js` — not
  duplicated across prompts, routes, or the Flutter app. Each file notes
  where its constants are illustrative placeholders that should be
  confirmed against current official scheme documentation before real
  production use.
- `recommended_safe_loan <= max_eligible_loan` is enforced twice:
  defensively inside `applyGuardrails()`, and again at the API contract
  boundary in `schemas/report.js`.
