/**
 * mc-worker.js
 *
 * Web Worker for Monte Carlo retirement simulation.
 * Runs entirely off the main thread — no DOM, no window.* globals.
 *
 * Receives one postMessage from mc-engine.js:
 *   { inputs, simCount, equityVol, inflationVol, clReturn }
 *
 * Posts back:
 *   { type: 'progress', pct }          — every 500 paths
 *   { type: 'done', result }           — when complete
 *
 * where result = {
 *   years, p10Portfolio, p25Portfolio, p50Portfolio, p75Portfolio, p90Portfolio,
 *   successRate, medianTotalTax
 * }
 *
 * ─── Simplifications vs deterministic engine ────────────────────────────────
 * • No Bed-and-ISA transfers (no CGT tracking needed at this level).
 * • No annotations or depletion records.
 * • Approximate income tax only (no CGT, no NI). Tax is a REPORTING figure
 *   only — not debited from any balance — mirroring engine.js, where income
 *   tax is recorded per-row but balances are not adjusted for it. This keeps
 *   MC and deterministic trajectories comparable.
 * • Tax thresholds are FROZEN (not uprated). This matches the most common real
 *   user setting and avoids needing the full threshold-uprating logic.
 * • Dividend mode: always 'payout' (conservative — dividends leave the GIA
 *   rather than compounding inside it, consistent with taxable-on-arising HMRC
 *   treatment and with the most common deterministic setting).
 *
 * NOTE — return sampling: growth and inflation are drawn independently each year
 * (i.i.d. log-normal via Box-Muller). Mean reversion is empirically more
 * realistic over long horizons but requires calibrating a reversion-speed
 * parameter users cannot verify. i.i.d. is the standard textbook assumption for
 * personal retirement Monte Carlo and is documented here as a known, deliberate
 * simplification for a future parameter if needed.
 *
 * ─── Withdrawal logic ───────────────────────────────────────────────────────
 * The worker implements two withdrawal modes: '50/50' (simple split) and
 * 'tax-aware' (PA headroom first, then residual split by headroom weight).
 * The deterministic engine supports four strategies (balanced, isaFirst,
 * sippFirst, taxMin); all four map to 'tax-aware' in the MC, as it is the
 * closest available approximation. Differentiating the four strategies in MC
 * would require porting the full withdrawal-strategy.js logic including ledger
 * state. This is a declared simplification, not a bug.
 *
 * ─── Target attainment (success criterion) ───────────────────────────────────
 * A path is counted as successful only if BOTH conditions hold every year:
 *   (a) the portfolio never hit zero, AND
 *   (b) total draws plus guaranteed income met the target.
 * A portfolio that survived because it refused to spend (under-funded the
 * household) must not count as a success.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SIPP_TAXABLE_RATIO = 0.75; // 25% SIPP lump sum is tax-free

// UK income tax bands 2024/25 — frozen (not uprated in MC paths).
// Non-savings income only (SP + salary + SIPP taxable portion).
const TAX_BANDS = [
  { limit: 12570,  rate: 0 },
  { limit: 50270,  rate: 0.20 },
  { limit: 125140, rate: 0.40 },
  { limit: Infinity, rate: 0.45 },
];

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIVE MATH — equivalents of RetireCalc methods
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grow all wrapper balances by (1 + rate). Mutates bal in place.
 * Equivalent to C.growBalances in calculator.js.
 */
function growBalances(bal, equityRate, inflationRate, clRate) {
  bal.Cash    = (bal.Cash    || 0);                        // Cash earns 0% — CA_RETURN = 0 in mc-assumptions.js
  bal.GIAeq   = (bal.GIAeq   || 0) * (1 + equityRate);  // Equity GIA — full equity vol
  bal.GIAcash = (bal.GIAcash || 0) * (1 + clRate);       // Cashlike GIA — CL_RETURN net of fee, no equity vol
  bal.ISA     = (bal.ISA     || 0) * (1 + equityRate);
  bal.SIPP    = (bal.SIPP    || 0) * (1 + equityRate);
}

/**
 * Sum all wrapper balances.
 * Equivalent to C.totalBal in calculator.js.
 */
function totalBal(bal) {
  return (bal.Cash || 0) + (bal.GIAeq || 0) + (bal.GIAcash || 0) + (bal.ISA || 0) + (bal.SIPP || 0);
}

/**
 * Draw `amount` from wrappers in the given order. Mutates bal in place.
 * SIPP draws: 75% is taxable income (sippTaxable). Cash is never in order here
 * (cash handled upstream, exactly as in engine.js).
 * Returns { GIA, SIPP, ISA, Cash, sippTaxable }.
 * Equivalent to C.withdraw in calculator.js.
 */
function withdraw(bal, order, amount) {
  const drawn = { GIA: 0, SIPP: 0, ISA: 0, Cash: 0, sippTaxable: 0 };
  let remaining = amount;

  for (const wrapper of order) {
    if (remaining <= 0) break;
    if (wrapper === 'GIA') {
      // Draw from cashlike GIA first (capital preservation), then equity GIA.
      for (const sub of ['GIAcash', 'GIAeq']) {
        if (remaining <= 0) break;
        const available = bal[sub] || 0;
        if (available <= 0) continue;
        const take = Math.min(remaining, available);
        bal[sub]  -= take;
        drawn.GIA += take;
        remaining -= take;
      }
    } else {
      const available = bal[wrapper] || 0;
      if (available <= 0) continue;
      const take = Math.min(remaining, available);
      bal[wrapper] -= take;
      drawn[wrapper] += take;
      remaining -= take;
      if (wrapper === 'SIPP') {
        drawn.sippTaxable += take * SIPP_TAXABLE_RATIO;
      }
    }
  }

  return drawn;
}

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAWAL STRATEGY
// Faithfully reproduced from withdrawal-strategy.js with C.withdraw /
// C.SIPP_TAXABLE_RATIO replaced by local equivalents above.
// ─────────────────────────────────────────────────────────────────────────────

function withdrawalStrategy({
  mode,
  shortfall,
  p1Bal, p2Bal,
  p1WrapperOrder, p2WrapperOrder,
  p1SIPPLocked, p2SIPPLocked,
  p1PAHeadroom, p2PAHeadroom,
}) {
  const zero = () => ({ GIA: 0, SIPP: 0, ISA: 0, Cash: 0, sippTaxable: 0 });

  // ── 50/50 mode ──────────────────────────────────────────────────────────
  if (mode === '50/50') {
    const p1Half  = shortfall / 2;
    const p1Drawn = withdraw(p1Bal, p1WrapperOrder, p1Half);
    const p1Unmet = Math.max(0, p1Half - p1Drawn.GIA - p1Drawn.SIPP - p1Drawn.ISA);

    const p2Drawn = withdraw(p2Bal, p2WrapperOrder, shortfall / 2 + p1Unmet);
    const p2Unmet = Math.max(
      0,
      (shortfall / 2 + p1Unmet) - p2Drawn.GIA - p2Drawn.SIPP - p2Drawn.ISA
    );

    if (p2Unmet > 0) {
      const extra = withdraw(p1Bal, p1WrapperOrder, p2Unmet);
      p1Drawn.GIA         += extra.GIA;
      p1Drawn.SIPP        += extra.SIPP;
      p1Drawn.ISA         += extra.ISA;
      p1Drawn.sippTaxable += extra.sippTaxable;
    }

    return { p1Drawn, p2Drawn };
  }

  // ── Tax-aware mode ───────────────────────────────────────────────────────
  if (shortfall <= 0) {
    return { p1Drawn: zero(), p2Drawn: zero() };
  }

  // Step 1: fill each person's PA headroom from SIPP (if accessible).
  const p1SippTarget = (!p1SIPPLocked && p1PAHeadroom > 0)
    ? Math.min(p1PAHeadroom / SIPP_TAXABLE_RATIO, p1Bal.SIPP || 0)
    : 0;
  const p2SippTarget = (!p2SIPPLocked && p2PAHeadroom > 0)
    ? Math.min(p2PAHeadroom / SIPP_TAXABLE_RATIO, p2Bal.SIPP || 0)
    : 0;

  const p1Drawn = withdraw(p1Bal, ['SIPP'], p1SippTarget);
  const p2Drawn = withdraw(p2Bal, ['SIPP'], p2SippTarget);

  // Step 2: remaining shortfall split proportionally by residual PA headroom.
  const p1SippTaxable = p1Drawn.sippTaxable;
  const p2SippTaxable = p2Drawn.sippTaxable;
  const p1RemHeadroom = Math.max(0, p1PAHeadroom - p1SippTaxable);
  const p2RemHeadroom = Math.max(0, p2PAHeadroom - p2SippTaxable);
  const sippDrawTotal = p1Drawn.SIPP + p2Drawn.SIPP;
  const remShortfall  = Math.max(0, shortfall - sippDrawTotal);

  const totalHeadroom = p1RemHeadroom + p2RemHeadroom;
  const p1Weight      = totalHeadroom > 0 ? p1RemHeadroom / totalHeadroom : 0.5;
  const p2Weight      = 1 - p1Weight;

  const p1NonSippOrder = p1WrapperOrder.filter(w => w !== 'SIPP' && w !== 'Cash');
  const p2NonSippOrder = p2WrapperOrder.filter(w => w !== 'SIPP' && w !== 'Cash');

  const p1RemDrawn = withdraw(p1Bal, p1NonSippOrder, remShortfall * p1Weight);
  const p2RemDrawn = withdraw(p2Bal, p2NonSippOrder, remShortfall * p2Weight);

  p1Drawn.GIA += p1RemDrawn.GIA;
  p1Drawn.ISA += p1RemDrawn.ISA;
  p2Drawn.GIA += p2RemDrawn.GIA;
  p2Drawn.ISA += p2RemDrawn.ISA;

  // Step 3: fallback — unmet demand goes to the other person.
  const p1Unmet = Math.max(
    0,
    remShortfall * p1Weight - p1RemDrawn.GIA - p1RemDrawn.ISA - p1RemDrawn.SIPP
  );
  const p2Unmet = Math.max(
    0,
    remShortfall * p2Weight - p2RemDrawn.GIA - p2RemDrawn.ISA - p2RemDrawn.SIPP
  );

  if (p1Unmet > 0) {
    const extra = withdraw(p2Bal, p2WrapperOrder, p1Unmet);
    p2Drawn.GIA         += extra.GIA;
    p2Drawn.ISA         += extra.ISA;
    p2Drawn.SIPP        += extra.SIPP;
    p2Drawn.sippTaxable += extra.sippTaxable;
  }
  if (p2Unmet > 0) {
    const extra = withdraw(p1Bal, p1WrapperOrder, p2Unmet);
    p1Drawn.GIA         += extra.GIA;
    p1Drawn.ISA         += extra.ISA;
    p1Drawn.SIPP        += extra.SIPP;
    p1Drawn.sippTaxable += extra.sippTaxable;
  }

  // Step 4: final catch-all — draw more SIPP as last resort.
  const totalDrawn =
    p1Drawn.GIA + p1Drawn.SIPP + p1Drawn.ISA +
    p2Drawn.GIA + p2Drawn.SIPP + p2Drawn.ISA;
  const stillUnmet = Math.max(0, shortfall - totalDrawn);

  if (stillUnmet > 0) {
    const p1Extra = !p1SIPPLocked
      ? withdraw(p1Bal, ['SIPP'], stillUnmet / 2)
      : { SIPP: 0, sippTaxable: 0 };
    const p2Share = stillUnmet / 2 + Math.max(0, stillUnmet / 2 - p1Extra.SIPP);
    const p2Extra = !p2SIPPLocked
      ? withdraw(p2Bal, ['SIPP'], p2Share)
      : { SIPP: 0, sippTaxable: 0 };

    p1Drawn.SIPP        += p1Extra.SIPP;
    p1Drawn.sippTaxable += p1Extra.sippTaxable;
    p2Drawn.SIPP        += p2Extra.SIPP;
    p2Drawn.sippTaxable += p2Extra.sippTaxable;

    const p2StillUnmet = Math.max(0, stillUnmet / 2 - p2Extra.SIPP);
    if (p2StillUnmet > 0 && !p1SIPPLocked) {
      const p1Last = withdraw(p1Bal, ['SIPP'], p2StillUnmet);
      p1Drawn.SIPP        += p1Last.SIPP;
      p1Drawn.sippTaxable += p1Last.sippTaxable;
    }
  }

  return { p1Drawn, p2Drawn };
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROXIMATE INCOME TAX
// Non-savings income only (SP + salary + SIPP taxable portion).
// No CGT, no NI, no savings/dividend bands — appropriate for portfolio
// trajectory modelling where we need tax drag, not a full SA302.
// Personal Allowance tapered above £100k.
// ─────────────────────────────────────────────────────────────────────────────

function approxIncomeTax(nonSavingsIncome) {
  // Taper PA for incomes above £100k: PA reduces by £1 for every £2 over £100k.
  let pa = 12570;
  if (nonSavingsIncome > 100000) {
    pa = Math.max(0, pa - Math.floor((nonSavingsIncome - 100000) / 2));
  }

  // Tax is levied on post-PA income only. `remaining` must start here, not at
  // gross — the old code started at gross and then subtracted `adjLow` from each
  // band width, which double-counted the PA-free slice and over-stated tax.
  // e.g. £20,000 gross: taxable = £7,430, correct tax = £1,486 not ~£4,000.
  const taxableIncome = Math.max(0, nonSavingsIncome - pa);

  let tax      = 0;
  let remaining = taxableIncome;
  let prevLimit = 0;

  for (const band of TAX_BANDS) {
    // Band width in taxable-income space (post-PA): subtract PA from each nominal
    // limit so that the zero-rate band has zero width and bands above start at 0.
    const bandLow  = prevLimit;
    const bandHigh = band.limit;
    const adjLow   = Math.max(0, bandLow  - pa);
    const adjHigh  = Math.max(0, bandHigh - pa);
    const width    = adjHigh - adjLow;
    const taxable  = Math.min(remaining, width);
    if (taxable > 0) tax += taxable * band.rate;
    remaining -= taxable;
    prevLimit  = band.limit;
    if (remaining <= 0) break;
  }

  return Math.max(0, tax);
}

// ─────────────────────────────────────────────────────────────────────────────
// BOX-MULLER TRANSFORM
// Returns a standard normal variate (mean=0, sd=1).
// ─────────────────────────────────────────────────────────────────────────────

function boxMuller() {
  // Two independent uniform samples → one normal variate.
  // We discard the second to keep the call site simple (no state needed).
  let u, v;
  do { u = Math.random(); } while (u === 0); // guard against log(0)
  do { v = Math.random(); } while (v === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Sample an annual rate from N(mean, vol), clamped to [floor, ceiling].
 * mean and vol are decimals (e.g. 0.05 for 5%).
 */
function sampleRate(mean, vol, floor = -0.5, ceiling = 2.0) {
  const sample = mean + vol * boxMuller();
  return Math.min(ceiling, Math.max(floor, sample));
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE-PATH SIMULATION
// Runs one deterministic path with the supplied per-year growth/inflation arrays
// (or samples them inline when not pre-supplied — we sample inline for clarity).
// Returns { portfolioByYear, taxByYear, survived }
//   portfolioByYear — Float64Array of end-of-year total portfolio, one per year
//   taxByYear       — Float64Array of total household tax, one per year
//   survived        — true if portfolio never hit zero across all years
// ─────────────────────────────────────────────────────────────────────────────

function runPath(inputs, equityVol, inflationVol, clReturn, stressMode, stressParams, blendedVol) {
  const {
    startYear, endYear,
    p1DOB, p2DOB,
    p1SPAge, p1SPAmt,
    p2SPAge, p2SPAmt,
    p1Salary, p1SalaryStop,
    p2Salary, p2SalaryStop,
    spending, stepDownPct,
    growth, inflation,
    withdrawalMode,
    p1Order, p2Order,
    dividendYield,
    p2enabled,
    deferYears,
    intAccts,
    p1PensionSweep,
    p2PensionSweep,
  } = inputs;

  // Pension sweep constants — mirrors engine.js logic exactly.
  // No annotations in the worker (reporting only); balance mutation is identical.
  const p1PensionMonthlyNet = p1PensionSweep?.monthlyNet || 0;
  const p1PensionStopAge    = p1PensionSweep?.stopAge    || 0;
  const p2PensionMonthlyNet = p2PensionSweep?.monthlyNet || 0;
  const p2PensionStopAge    = p2PensionSweep?.stopAge    || 0;
  const PENSION_AA          = 60000;

  const numYears = endYear - startYear + 1;

  // Deep-copy balances — each path starts from the same opening position.
  const p1Bal = { ...inputs.p1Bal };
  const p2Bal = { ...inputs.p2Bal };

  // Deep-copy interest accounts so each path starts from the same balances.
  const pathIntAccts = (intAccts || []).map(a => ({ ...a }));

  // Frozen tax thresholds (see file-level note).
  const PA = 12570;

  let cumInfl  = 1;
  let survived = true;

  const portfolioByYear = new Float64Array(numYears);
  const taxByYear       = new Float64Array(numYears);

  for (let yi = 0; yi < numYears; yi++) {
    const year  = startYear + yi;
    const p1Age = year - p1DOB;
    const p2Age = year - p2DOB;

    // ── Sample this year's rates (stress-aware) ───────────────────────────
    // Baseline: growth ~ N(growth, equityVol), inflation ~ N(inflation, inflationVol).
    // Stress modes alter the distribution for a specific window of years only;
    // outside the window, baseline sampling resumes.
    //
    // sorr (Sequence of Returns Risk):
    //   First 5 years: blended portfolio growth mean shifted down by 1 sigma of
    //   blended vol (equityWt * equityVol + bondWt * bondVol, pre-computed by
    //   self.onmessage and passed in as blendedVol).
    //   Using blended vol (rather than raw equityVol) keeps the shock proportional
    //   to the actual portfolio mix. 1 sigma produces a ~30% cumulative drawdown
    //   over 5 years at baseline assumptions — calibrated to a realistic bad-but-
    //   survivable early-retirement sequence (cf. 2000-02 dot-com period).
    //   Previously: growth - 2 * equityVol (~66% drawdown, overstated).
    //
    // inflation (High/Persistent Inflation):
    //   Years 1-10: inflation ~ N(5.5%, 1.5%).
    //   Mean calibrated to the 2022-23 UK peak average rather than 1970s worst —
    //   painful and sustained but plausible in a modern context.
    //   Vol aligned with baseline inflationVol assumption (1.5%).
    //   Previously: N(7.5%, 2.0%) — overstated for a diversified modern portfolio.
    //
    // lostDecade (Lost Decade):
    //   A fixed 10-year window (stressParams.lostDecadeStart, computed once per run
    //   by mc-engine.js so all paths share the same shocked window):
    //   growth ~ N(0.5%, equityVol) during the window.
    //   Marginally positive nominal return reflects the actual MSCI World 2000-2010
    //   experience for a globally diversified portfolio — near-zero rather than
    //   outright negative. Previously: -0.5% (implied persistent nominal losses).
    //   Models Japan-1990s or US-2000s stagnant-growth decade at an unpredictable time.

    let growthMean    = growth;
    let growthVol     = equityVol;
    let inflationMean = inflation;
    let inflVol       = inflationVol;

    if (stressMode === 'sorr') {
      if (yi < 5) growthMean = growth - 1 * blendedVol;
      // inflationVol unchanged
    } else if (stressMode === 'inflation') {
      if (yi < 10) { inflationMean = 0.055; inflVol = 0.015; }
      // growth unchanged
    } else if (stressMode === 'lostDecade' && stressParams) {
      const winStart = stressParams.lostDecadeStart;
      if (yi >= winStart && yi < winStart + 10) growthMean = 0.005;
      // inflationVol unchanged
    }

    const growthY    = sampleRate(growthMean,    growthVol, -0.5, 2.0);
    const inflationY = sampleRate(inflationMean, inflVol,   -0.1, 0.5);

    // ── Guaranteed income (nominal) ────────────────────────────────────────
    const p1SP     = p1Age >= p1SPAge ? p1SPAmt * cumInfl : 0;
    const p2SP     = (p2enabled && p2Age >= p2SPAge) ? p2SPAmt * cumInfl : 0;
    const p1SalInc = (p1SalaryStop && p1Age <= p1SalaryStop) ? p1Salary * cumInfl : 0;
    const p2SalInc = (p2enabled && p2SalaryStop && p2Age <= p2SalaryStop)
      ? p2Salary * cumInfl : 0;

    // ── Pension sweep contributions ──────────────────────────────────────────
    // Mirrors engine.js: gross-up by /0.8, cap at lower of salary and £60k AA,
    // uprate by cumInfl. Applied before spending target so the enlarged SIPP
    // balance is immediately available for drawdown in this and future years.
    if (p1PensionMonthlyNet > 0 && (!p1PensionStopAge || p1Age <= p1PensionStopAge)) {
      const p1NetAnnual   = p1PensionMonthlyNet * 12 * cumInfl;
      const p1GrossTarget = p1NetAnnual / 0.8;
      const p1SalaryCap   = p1SalInc > 0 ? p1SalInc : 0;
      const p1Capped      = Math.min(p1GrossTarget, PENSION_AA, p1SalaryCap > 0 ? p1SalaryCap : PENSION_AA);
      if (p1Capped > 0) p1Bal.SIPP = (p1Bal.SIPP || 0) + p1Capped;
    }
    if (p2enabled && p2PensionMonthlyNet > 0 && (!p2PensionStopAge || p2Age <= p2PensionStopAge)) {
      const p2NetAnnual   = p2PensionMonthlyNet * 12 * cumInfl;
      const p2GrossTarget = p2NetAnnual / 0.8;
      const p2SalaryCap   = p2SalInc > 0 ? p2SalInc : 0;
      const p2Capped      = Math.min(p2GrossTarget, PENSION_AA, p2SalaryCap > 0 ? p2SalaryCap : PENSION_AA);
      if (p2Capped > 0) p2Bal.SIPP = (p2Bal.SIPP || 0) + p2Capped;
    }

    // ── Windfall injections ───────────────────────────────────────────────────
    // Mirrors engine.js: amount * cumInfl at the landing year, per-person, per-wrapper.
    // No annotations in the worker.
    if (inputs.windfalls && inputs.windfalls.length > 0) {
      inputs.windfalls.forEach(function(wf) {
        if (wf.year !== year) return;
        const nominal   = wf.amount * cumInfl;
        const bal       = wf.person === 'p2' ? p2Bal : p1Bal;
        if (wf.wrapper === 'GIA') {
          const eqPct   = (wf.equityPct ?? 70) / 100;
          const eqShare = nominal * eqPct;
          const caShare = nominal * (1 - eqPct);
          bal.GIA     = (bal.GIA     || 0) + nominal;
          bal.GIAeq   = (bal.GIAeq   || 0) + eqShare;
          bal.GIAcash = (bal.GIAcash || 0) + caShare;
        } else {
          bal[wf.wrapper] = (bal[wf.wrapper] || 0) + nominal;
        }
      });
    }

    // ── GIA dividends (payout mode — equity GIA only; cashlike GIA is income-generating
    //    but modelled via low-vol growth rather than dividend yield) ──────────────────
    const p1Divs = (p1Bal.GIAeq || 0) * dividendYield;
    const p2Divs = p2enabled ? (p2Bal.GIAeq || 0) * dividendYield : 0;
    // Deduct from GIAeq pre-growth (ex-dividend balance grows)
    p1Bal.GIAeq = Math.max(0, (p1Bal.GIAeq || 0) - p1Divs);
    if (p2enabled) p2Bal.GIAeq = Math.max(0, (p2Bal.GIAeq || 0) - p2Divs);

    // ── Spending target (nominal, with step-down) ──────────────────────────
    const target = spending * cumInfl * (
      stepDownPct > 0 && p1Age >= 75 ? (1 - stepDownPct / 100) : 1
    );

    // ── SIPP lock ──────────────────────────────────────────────────────────
    const minPensionAge = year >= 2028 ? 57 : 55;
    const p1SIPPLocked  = p1Age < minPensionAge;
    const p2SIPPLocked  = !p2enabled || p2Age < minPensionAge;

    // ── Guaranteed income total before portfolio draws ─────────────────────
    const guaranteed = p1SP + p2SP + p1SalInc + p2SalInc + p1Divs + p2Divs;
    const surplus    = Math.max(0, guaranteed - target);
    if (surplus > 0) p1Bal.Cash = (p1Bal.Cash || 0) + surplus;

    let shortfall = Math.max(0, target - guaranteed);

    // ── Interest-bearing accounts ──────────────────────────────────────────
    // Draw from each account up to its monthly draw target, capped by balance.
    // Interest is earned at the account's nominal rate (not inflation-linked).
    // This mirrors engine.js intAccts handling but without tax tracking.
    let intBudget = shortfall;
    for (const a of pathIntAccts) {
      if ((a.balance || 0) <= 0 || intBudget <= 0) continue;
      const effectiveRate  = Math.pow(1 + (a.rate / 100) / 365, 365) - 1;
      const interestEarned = a.balance * effectiveRate;
      const annualTarget   = (a.monthlyDraw || 0) * 12;
      if (annualTarget <= 0) {
        // No draw — just accrue interest
        a.balance += interestEarned;
        continue;
      }
      const drawActual    = Math.min(annualTarget, intBudget, a.balance + interestEarned);
      const interestDrawn = Math.min(drawActual, interestEarned);
      a.balance -= Math.max(0, drawActual - interestDrawn);
      a.balance += interestEarned - interestDrawn;
      a.balance  = Math.max(0, a.balance);
      shortfall -= drawActual;
      intBudget -= drawActual;
    }
    shortfall = Math.max(0, shortfall);

    // ── Deferral: suppress all portfolio draws during delay period ────────
    if (deferYears && yi < deferYears) shortfall = 0;

    // ── Priority 1: cash ───────────────────────────────────────────────────
    if (shortfall > 0) {
      const totalCash = (p1Bal.Cash || 0) + (p2Bal.Cash || 0);
      const cashDrawn = Math.min(shortfall, totalCash);
      const fromP1    = Math.min(cashDrawn, p1Bal.Cash || 0);
      const fromP2    = Math.max(0, cashDrawn - fromP1);
      p1Bal.Cash  = Math.max(0, (p1Bal.Cash || 0) - fromP1);
      p2Bal.Cash  = Math.max(0, (p2Bal.Cash || 0) - fromP2);
      shortfall  -= cashDrawn;
    }

    // ── Priority 2: wrapper draws via configured strategy ─────────────────
    const p1WrapperOrder = p1Order.filter(
      w => w !== 'Cash' && !(w === 'SIPP' && p1SIPPLocked)
    );
    const p2WrapperOrder = (p2enabled ? p2Order : []).filter(
      w => w !== 'Cash' && !(w === 'SIPP' && p2SIPPLocked)
    );

    // PA headroom for tax-aware mode (non-savings guaranteed income only).
    // Dividends are savings income and do not consume the non-savings PA headroom
    // that governs how much SIPP can be drawn tax-free. Deducting p1Divs/p2Divs
    // here was Bug 7 — it under-stated headroom and suppressed SIPP draws.
    const p1PAHeadroom = Math.max(0, PA - p1SP - p1SalInc);
    const p2PAHeadroom = p2enabled ? Math.max(0, PA - p2SP - p2SalInc) : 0;

    const { p1Drawn, p2Drawn } = withdrawalStrategy({
      mode: withdrawalMode,
      shortfall,
      p1Bal, p2Bal,
      p1WrapperOrder, p2WrapperOrder,
      p1SIPPLocked, p2SIPPLocked,
      p1PAHeadroom, p2PAHeadroom,
    });

    // ── Priority 3: residual interest-account sweep ───────────────────────
    // Mirrors engine.js behaviour. The intAccts loop above respects each
    // account's configured monthly draw (soft cap reflecting its role as a
    // steady income source). But if wrappers deplete and shortfall remains,
    // leaving capital stranded in a liquid interest account is wrong. Sweep
    // the residual here. Interest for this year was already accrued above,
    // so only capital is moved here.
    const wrapperDrawn =
      (p1Drawn.GIA || 0) + (p1Drawn.SIPP || 0) + (p1Drawn.ISA || 0) +
      (p2Drawn.GIA || 0) + (p2Drawn.SIPP || 0) + (p2Drawn.ISA || 0);
    let residualShortfall = Math.max(0, shortfall - wrapperDrawn);
    if (residualShortfall > 0) {
      for (const a of pathIntAccts) {
        if (residualShortfall <= 0) break;
        if ((a.balance || 0) <= 0) continue;
        const extra = Math.min(a.balance, residualShortfall);
        a.balance         -= extra;
        residualShortfall -= extra;
      }
    }

    // ── Growth ────────────────────────────────────────────────────────────
    growBalances(p1Bal, growthY, inflationY, clReturn);
    if (p2enabled) growBalances(p2Bal, growthY, inflationY, clReturn);

    // ── Approximate tax (reporting only — NOT debited from any balance) ──
    // Target is gross, so shortfall-sized wrapper draws already account for
    // tax implicitly. Debiting tax from cash would double-count. This mirrors
    // engine.js, which records income tax as a reporting figure without
    // adjusting balances. See 'Approximate income tax' note above — no CGT,
    // no NI, no savings/dividend bands.
    const p1NonSavings = p1SP + p1SalInc + p1Drawn.sippTaxable;
    const p2NonSavings = p2enabled ? (p2SP + p2SalInc + p2Drawn.sippTaxable) : 0;
    const p1Tax = approxIncomeTax(p1NonSavings);
    const p2Tax = p2enabled ? approxIncomeTax(p2NonSavings) : 0;
    const totalTax = p1Tax + p2Tax;

    // ── Record end-of-year values ──────────────────────────────────────────
    const intAcctTotal = pathIntAccts.reduce((sum, a) => sum + (a.balance || 0), 0);
    const portfolio = totalBal(p1Bal) + (p2enabled ? totalBal(p2Bal) : 0) + intAcctTotal;
    portfolioByYear[yi] = portfolio;
    taxByYear[yi]       = totalTax;

    // ── Success tracking ───────────────────────────────────────────────────
    // A path is only successful if every year met target AND portfolio never
    // hit zero. Previously success was terminal-balance-only, which counted
    // paths that under-funded target as "survived" provided some residual
    // balance remained.
    if (portfolio <= 0) survived = false;
    if (residualShortfall > 0.01) survived = false;

    // ── Advance inflation for next year ────────────────────────────────────
    cumInfl *= (1 + inflationY);
  }

  return { portfolioByYear, taxByYear, survived };
}

// ─────────────────────────────────────────────────────────────────────────────
// PERCENTILE HELPER
// Operates on a pre-sorted array — caller must sort before calling.
// ─────────────────────────────────────────────────────────────────────────────

function percentile(sortedArr, p) {
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const { inputs, simCount, equityVol, inflationVol, mcGrowth, clReturn, stressMode, stressParams, bondVol, equityWt } = e.data;
  const effectiveClReturn = clReturn ?? 0.0228; // fallback: CL_RETURN (2.5%) - ANNUAL_FEE (0.22%)

  // Blended portfolio vol — used by the SORR stress to size the shock proportionally
  // to the actual asset mix rather than anchoring to pure equity vol.
  // equityWt and bondVol are optional; if absent we fall back to equityVol alone
  // (conservative, consistent with the old behaviour for callers that don't supply them).
  const effectiveBondVol = bondVol ?? 0.07;
  const effectiveEquityWt = equityWt ?? 1.0;
  const blendedVol = effectiveEquityWt * equityVol + (1 - effectiveEquityWt) * effectiveBondVol;

  // If mcGrowth is provided, override inputs.growth with the historically-grounded
  // figure from mc-assumptions.js. This allows the MC engine to use realistic
  // market return assumptions independent of the user's conservative planning rate.
  const withMcGrowth = (mcGrowth !== undefined && mcGrowth !== null)
    ? { ...inputs, growth: mcGrowth }
    : inputs;

  // Map the deterministic strategy (balanced / isaFirst / sippFirst / taxMin)
  // to the worker's withdrawal mode. The worker implements a simplified
  // two-mode system ('50/50' and 'tax-aware'); the four deterministic strategies
  // collapse to these as the closest available approximations:
  //   balanced / isaFirst / taxMin / sippFirst → 'tax-aware'
  // This is a known simplification. Differentiating the four strategies in MC
  // would require porting the full withdrawal-strategy.js logic including
  // ledger state — out of scope here. 'tax-aware' is the most faithful shared
  // behaviour (PA headroom first, then split by residual headroom).
  const effectiveInputs = {
    ...withMcGrowth,
    withdrawalMode: withMcGrowth.withdrawalMode
      || withMcGrowth.strategy        // passthrough so future strategy work sees the label
      || 'tax-aware',
  };

  const numYears = effectiveInputs.endYear - effectiveInputs.startYear + 1;

  // Accumulate per-year arrays across all paths.
  // portfolioMatrix[yi] = array of end-of-year portfolio values across paths.
  // taxMatrix[yi]       = array of total tax values across paths.
  const portfolioMatrix = Array.from({ length: numYears }, () => new Float64Array(simCount));
  const taxMatrix       = Array.from({ length: numYears }, () => new Float64Array(simCount));

  let successCount = 0;
  const PROGRESS_INTERVAL = 500;

  for (let sim = 0; sim < simCount; sim++) {
    const { portfolioByYear, taxByYear, survived } = runPath(effectiveInputs, equityVol, inflationVol, effectiveClReturn, stressMode, stressParams, blendedVol);

    for (let yi = 0; yi < numYears; yi++) {
      portfolioMatrix[yi][sim] = portfolioByYear[yi];
      taxMatrix[yi][sim]       = taxByYear[yi];
    }

    if (survived) successCount++;

    // Progress heartbeat every 500 paths.
    if ((sim + 1) % PROGRESS_INTERVAL === 0) {
      self.postMessage({ type: 'progress', pct: Math.round(((sim + 1) / simCount) * 100) });
    }
  }

  // ── Compute percentiles per year ─────────────────────────────────────────
  // Sort each year's column in place (Float64Array.sort is in-place).
  const p10 = new Float64Array(numYears);
  const p25 = new Float64Array(numYears);
  const p50 = new Float64Array(numYears);
  const p75 = new Float64Array(numYears);
  const p90 = new Float64Array(numYears);
  const medTax = new Float64Array(numYears);

  const years = [];
  for (let yi = 0; yi < numYears; yi++) {
    years.push(inputs.startYear + yi);

    const pCol = portfolioMatrix[yi];
    pCol.sort();
    p10[yi] = percentile(pCol, 10);
    p25[yi] = percentile(pCol, 25);
    p50[yi] = percentile(pCol, 50);
    p75[yi] = percentile(pCol, 75);
    p90[yi] = percentile(pCol, 90);

    const tCol = taxMatrix[yi];
    tCol.sort();
    medTax[yi] = percentile(tCol, 50);
  }

  // ── Per-year survival counts (portfolio > 0) ─────────────────────────────
  // survivalByYear[yi] = number of paths still solvent at end of year yi.
  // Used to compute decade-by-decade survival rates in mc-render.js.
  const survivalByYear = new Int32Array(numYears);
  for (let yi = 0; yi < numYears; yi++) {
    // portfolioMatrix[yi] is already sorted ascending after percentile pass.
    const col = portfolioMatrix[yi];
    let solvent = 0;
    for (let s = 0; s < simCount; s++) {
      if (col[s] > 0) solvent++;
    }
    survivalByYear[yi] = solvent;
  }

  // ── Earliest depletion year across all paths ──────────────────────────────
  // The first year where any path hits zero — i.e. the worst-case onset.
  let earliestDepletion = null;
  for (let yi = 0; yi < numYears; yi++) {
    if (survivalByYear[yi] < simCount) {
      earliestDepletion = inputs.startYear + yi;
      break;
    }
  }

  // ── Effective mean inflation for deflation in mc-render.js ──────────────────
  // The inflation stress uses a different mean (5.5%) for years 0-9, then reverts
  // to the baseline mean. mc-render.js uses _meanInflation (baseline only) for
  // real-terms deflation, causing stress nominal balances to be under-discounted.
  // We compute and return the horizon-weighted mean so the renderer can use the
  // correct deflation rate for each stress scenario.
  const _baseMeanInflation = effectiveInputs.inflation ?? 0.025;
  let stressInflationMean;
  if (stressMode === 'inflation') {
    // Years 0-9: mean 5.5%, remaining years: baseline mean.
    const stressedYears   = Math.min(10, numYears);
    const unstressedYears = Math.max(0, numYears - 10);
    stressInflationMean   =
      (stressedYears * 0.055 + unstressedYears * _baseMeanInflation) / numYears;
  } else {
    // SORR and lostDecade don't alter inflation — use baseline mean.
    stressInflationMean = _baseMeanInflation;
  }

  const result = {
    mode:             'montecarlo',
    stressMode:       stressMode || null,
    stressParams:     stressParams || null,
    stressInflationMean,    // weighted mean inflation across the horizon — for real-terms deflation
    simCount,
    years,
    p10Portfolio:     Array.from(p10),
    p25Portfolio:     Array.from(p25),
    p50Portfolio:     Array.from(p50),
    p75Portfolio:     Array.from(p75),
    p90Portfolio:     Array.from(p90),
    successRate:      successCount / simCount,
    medianTotalTax:   Array.from(medTax),
    survivalByYear:   Array.from(survivalByYear),
    earliestDepletion,
    equityVol,
    inflationVol,
  };

  self.postMessage({ type: 'done', result });
};

// Test shim — allows tests-approx-income-tax.html to access the live function
// without copy-pasting it. Only active when the worker is imported as a module
// in a non-Worker context (e.g. via importScripts in a test harness).
// Never used in production paths.
if (typeof self !== 'undefined') {
  self._approxIncomeTaxForTest = approxIncomeTax;
}
