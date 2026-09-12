import { PdfDocument } from './pdfWriter.js';
import { feasibilityReportSchema } from '../schemas/report.js';

/**
 * Phase 5.2 — Detailed Project Report (DPR) PDF generator.
 *
 * Structure (per the plan):
 *   GramUdyam / Detailed Project Report -> Location -> Proposed Business ->
 *   Project Cost -> Safe Loan -> Working Capital -> Estimated EMI ->
 *   Feasibility Explanation -> SWOT / Recommendations
 *
 * Production requirements enforced here:
 *  - Consistent typography (two weights, a handful of sizes).
 *  - Clear section headings with rules.
 *  - A table for financial values.
 *  - Proper page breaks (handled by PdfDocument's automatic pagination).
 *  - INR formatting (Indian digit grouping, see `formatInr`).
 *  - No raw internal errors leak into the document; malformed input is
 *    rejected before any PDF bytes are produced (see `generateDprPdf`).
 */

export class PdfGenerationError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'PdfGenerationError';
    this.status = 500;
    if (cause) this.cause = cause;
  }
}

/** Formats a non-negative number as "Rs. 1,23,456" using Indian digit grouping. */
export function formatInr(amount) {
  const n = Math.round(Number(amount) || 0);
  const [intPart] = String(Math.abs(n)).split('.');
  let formatted;
  if (intPart.length <= 3) {
    formatted = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    const withCommas = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    formatted = `${withCommas},${last3}`;
  }
  return `${n < 0 ? '-' : ''}Rs. ${formatted}`;
}

function formatLocation(location) {
  return [location.village, location.block, location.district, location.state].filter(Boolean).join(', ') || 'Not specified';
}

function formatRisk(classification) {
  return classification.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Renders a validated FeasibilityReport (see schemas/report.js) into a DPR
 * PDF. Throws PdfGenerationError (never a raw internal error) if `report`
 * doesn't match the expected schema — the route layer turns that into a
 * controlled HTTP 500/422, per the plan's "PDF generation failure must
 * return an API error rather than corrupt output" rule.
 */
export function generateDprPdf(report) {
  const parsed = feasibilityReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new PdfGenerationError('Cannot generate a DPR PDF from an invalid FeasibilityReport', { cause: parsed.error });
  }
  const r = parsed.data;

  let doc;
  try {
    doc = new PdfDocument({ title: 'GramUdyam Detailed Project Report' });

    doc.heading('GramUdyam', { size: 20 });
    doc.subheading('Detailed Project Report (DPR)');
    doc.paragraph(`Generated: ${new Date(r.generated_at).toISOString().slice(0, 10)}`, { size: 9.5 });
    doc.spacer(6);

    doc.subheading('Location');
    doc.paragraph(formatLocation(r.location));

    doc.subheading('Proposed Business');
    doc.paragraph(r.selected_business);

    doc.subheading('Financial Summary');
    doc.keyValueTable([
      ['Maximum eligible loan', formatInr(r.max_eligible_loan)],
      ['Recommended project cost', formatInr(r.recommended_project_cost)],
      ['Recommended safe loan', formatInr(r.recommended_safe_loan)],
      ['Working capital reserve', formatInr(r.working_capital_reserve)],
      ['Estimated monthly EMI', formatInr(r.monthly_emi)],
      ['Applicable scheme', r.recommended_scheme_name],
      ['Repayment risk classification', formatRisk(r.repayment_risk_classification)],
      ['Business readiness score', `${r.business_readiness_score} / 100`],
    ]);
    if (r.is_estimate) {
      doc.paragraph(
        'Note: one or more figures above rely on estimated (not independently verified) local assumptions. See warnings below.',
        { size: 9 }
      );
    }

    doc.subheading('Feasibility Explanation');
    doc.paragraph(r.plain_language_explanation);

    doc.subheading('SWOT Analysis');
    doc.paragraph('Strengths:', { size: 10.5 });
    doc.bulletList(r.swot_analysis.strengths);
    doc.paragraph('Weaknesses:', { size: 10.5 });
    doc.bulletList(r.swot_analysis.weaknesses);
    doc.paragraph('Opportunities:', { size: 10.5 });
    doc.bulletList(r.swot_analysis.opportunities);
    doc.paragraph('Threats:', { size: 10.5 });
    doc.bulletList(r.swot_analysis.threats);

    if (r.alternative_recommendations.length > 0) {
      doc.subheading('Alternative Business Recommendations');
      doc.bulletList(r.alternative_recommendations.map((a) => `${a.business} - ${a.rationale}`));
    }

    if (r.warnings.length > 0) {
      doc.subheading('Warnings');
      doc.bulletList(r.warnings);
    }

    return doc.build();
  } catch (error) {
    if (error instanceof PdfGenerationError) throw error;
    throw new PdfGenerationError('Unexpected error while generating the DPR PDF', { cause: error });
  }
}
