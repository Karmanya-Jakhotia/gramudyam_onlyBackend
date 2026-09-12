import { Router } from 'express';
import { generateFeasibilityReport } from '../services/reportService.js';

const router = Router();

// Takes the entrepreneur's own entered inputs (village, business, savings,
// monthly income, existing debt) and asks Gemini to generate the actual
// feasibility report content shown on the Feasibility Report screen and
// baked into the PDF — replacing the previous hardcoded "Demand: High" text.
router.post('/generate', async (req, res) => {
  const { village, business, savings, monthlyIncome, existingDebt } = req.body || {};

  if (
    typeof village !== 'string' || !village.trim() ||
    typeof business !== 'string' || !business.trim() ||
    typeof savings !== 'string' && typeof savings !== 'number'
  ) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'village, business and savings are required',
    });
  }

  try {
    const report = await generateFeasibilityReport({
      village: village.trim(),
      business: business.trim(),
      savings,
      monthlyIncome: monthlyIncome ?? '',
      existingDebt: existingDebt ?? '',
    });
    return res.json({ report });
  } catch (error) {
    console.error('[report/generate]', error);
    return res.status(error.status || 502).json({ error: 'report_generation_failed', message: error.message });
  }
});

export default router;
