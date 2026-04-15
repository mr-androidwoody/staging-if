/**
 * mc-render.js
 *
 * Renders Monte Carlo results into the Risk Outcomes sub-tab.
 * Registers window.RetireMCRender.
 *
 * Depends on:
 *   window.RetireData  – for D.formatMoney
 *
 * Public API:
 *   RetireMCRender.setResults(result, meanInflation)
 *   RetireMCRender.render()
 *   RetireMCRender.setReal(bool)
 */

(function () {
  'use strict';

  const D = window.RetireData;

  function fmt(n) {
    if (D && D.formatMoney) return D.formatMoney(n);
    return '£' + Math.round(n).toLocaleString('en-GB');
  }

  function fmtPct(ratio) {
    return (ratio * 100).toFixed(1) + '%';
  }

  function roundToNearest(n, nearest) {
    return Math.round(n / nearest) * nearest;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let _result          = null;
  let _meanInflation   = 0.025;
  let _useReal         = true;
  let _spendingContext = null; // { currentSpending, sustainableSpending, targetConfidence, openingPortfolio }

  // ── Deflation ─────────────────────────────────────────────────────────────
  function _deflate(v, i) {
    return _useReal ? v / Math.pow(1 + _meanInflation, i) : v;
  }
  function _deflateArr(arr) { return arr.map((v, i) => _deflate(v, i)); }

  // ── Public API ────────────────────────────────────────────────────────────
  function setResults(result, meanInflation, spendingContext) {
    _result          = result;
    _meanInflation   = (typeof meanInflation === 'number' && !isNaN(meanInflation))
      ? meanInflation : 0.025;
    _spendingContext = spendingContext || null;
  }

  function setReal(useReal) {
    _useReal = useReal;
    render();
  }

  function render() {
    if (!_result) return;
    _syncToggleButtons();
    _renderNarrative();
  }

  function _syncToggleButtons() {
    document.querySelectorAll('[data-action="mc-real-on"],[data-action="mc-real-off"]')
      .forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll(`[data-action="${_useReal ? 'mc-real-on' : 'mc-real-off'}"]`)
      .forEach(b => b.classList.add('is-active'));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NARRATIVE
  // ─────────────────────────────────────────────────────────────────────────
  function _renderNarrative() {
    const el = document.getElementById('mc-narrative');
    if (!el) return;

    const r         = _result;
    const lastIdx   = r.years.length - 1;
    const lastYear  = r.years[lastIdx];
    const firstYear = r.years[0];
    const modeLabel = _useReal ? 'real' : 'nominal';

    const p10 = _deflateArr(r.p10Portfolio);
    const p25 = _deflateArr(r.p25Portfolio);
    const p50 = _deflateArr(r.p50Portfolio);
    const p75 = _deflateArr(r.p75Portfolio);
    const p90 = _deflateArr(r.p90Portfolio);

    // Opening portfolio (real, year-0)
    const openingPortfolio = (_spendingContext && _spendingContext.openingPortfolio)
      ? _spendingContext.openingPortfolio
      : p50[0];

    // Update sim count in subtitle
    const simCountEl = document.getElementById('mc-sim-count');
    if (simCountEl) simCountEl.textContent = r.simCount.toLocaleString('en-GB');

    // ── Helpers ───────────────────────────────────────────────────────────
    function depletionYear(arr) {
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] <= 0) return r.years[i];
      }
      return null;
    }

    function peak(arr) {
      let maxVal = -Infinity, maxIdx = 0;
      arr.forEach((v, i) => { if (v > maxVal) { maxVal = v; maxIdx = i; } });
      return { value: maxVal, year: r.years[maxIdx] };
    }

    // ── INTRO ─────────────────────────────────────────────────────────────
    const introHTML = `
      <section class="mc-section mc-section--intro">
        <p>Your retirement plan has been stress-tested across ${r.simCount.toLocaleString('en-GB')} simulated
        futures, each with randomly varying investment returns and inflation.
        Unlike the single-path projection, this analysis shows the range of
        outcomes your plan could face – from favourable markets to sustained
        downturns. Use it to understand how resilient your plan is, where the
        risks concentrate, and whether you have enough buffer to weather a poor
        sequence of returns early in retirement.</p>
      </section>`;

    // ── KEY FIGURES ROW ───────────────────────────────────────────────────
    const p10Depletes = depletionYear(p10);
    const p10Label    = p10Depletes ? `Depletes ${p10Depletes}` : fmt(p10[lastIdx]);
    const p10Sub      = p10Depletes ? 'Portfolio exhausted' : `by ${lastYear} (${modeLabel})`;
    const p10Colour   = p10Depletes ? 'var(--danger, #dc2626)' : 'var(--text, #111827)';

    const keyFiguresHTML = `
      <div class="mc-key-figures">
        <div class="mc-key-figure">
          <span class="mc-key-figure__label">Stress case (10th %ile)</span>
          <span class="mc-key-figure__value" style="color:${p10Colour}">${p10Label}</span>
          <span class="mc-key-figure__sub">${p10Sub}</span>
        </div>
        <div class="mc-key-figure">
          <span class="mc-key-figure__label">Median outcome (50th %ile)</span>
          <span class="mc-key-figure__value">${fmt(p50[lastIdx])}</span>
          <span class="mc-key-figure__sub">by ${lastYear} (${modeLabel})</span>
        </div>
        <div class="mc-key-figure">
          <span class="mc-key-figure__label">Optimistic case (90th %ile)</span>
          <span class="mc-key-figure__value" style="color:var(--green-2, #16a34a)">${fmt(p90[lastIdx])}</span>
          <span class="mc-key-figure__sub">by ${lastYear} (${modeLabel})</span>
        </div>
      </div>`;

    // ── 1. VERDICT ────────────────────────────────────────────────────────
    const successPaths = Math.round(r.successRate * r.simCount);
    const verdictClass =
      r.successRate >= 0.95 ? 'mc-verdict--strong' :
      r.successRate >= 0.90 ? 'mc-verdict--good' :
      r.successRate >= 0.80 ? 'mc-verdict--moderate' :
                              'mc-verdict--weak';
    const verdictLabel =
      r.successRate >= 0.95 ? 'This is a strong result.' :
      r.successRate >= 0.90 ? 'This is a good result – well within acceptable confidence bounds.' :
      r.successRate >= 0.80 ? 'This is a moderate result – some vulnerability to poor sequences.' :
                              'This result warrants attention – a significant proportion of paths fail.';

    const verdictHTML = `
      <section class="mc-section mc-verdict ${verdictClass}">
        <h4 class="mc-section-heading">Verdict</h4>
        <p>Your plan succeeds in <strong>${successPaths.toLocaleString('en-GB')}</strong> of
        ${r.simCount.toLocaleString('en-GB')} simulations
        (<strong>${fmtPct(r.successRate)}</strong>). ${verdictLabel}</p>
      </section>`;

    // ── 2. SUSTAINABLE SPENDING ───────────────────────────────────────────
    let sustainHTML = '';
    let headroom    = null;

    if (_spendingContext && _spendingContext.sustainableSpending != null) {
      const { currentSpending, sustainableSpending, sustainableIsFloor, targetConfidence, openingPortfolio: op } = _spendingContext;
      headroom              = sustainableSpending - currentSpending;
      const isAbove         = headroom >= 0;
      const absDiff         = Math.abs(Math.round(headroom));
      const pctOfPort       = op > 0
        ? ((sustainableSpending / op) * 100).toFixed(1)
        : null;
      const confPct         = (targetConfidence * 100).toFixed(0);

      const overBy  = isAbove ? 0 : Math.abs(headroom) / currentSpending;
      const sClass  = isAbove        ? 'mc-sustain--safe' :
                      overBy <= 0.15 ? 'mc-sustain--warn' :
                                       'mc-sustain--danger';

      const portClause  = pctOfPort ? ` (${pctOfPort}% of your opening portfolio)` : '';
      const floorPrefix = sustainableIsFloor ? 'at least ' : '';

      let sustainBody;
      if (sustainableIsFloor) {
        sustainBody = `Your plan succeeds in <strong>${confPct}%</strong> or more of simulations even at
          <strong>${fmt(sustainableSpending)}</strong>/year – <strong>${fmt(absDiff)}</strong>/year above your current target.
          Your plan is highly resilient; the true sustainable spending level is likely higher still.`;
      } else if (isAbove) {
        sustainBody = `Your current spending target of <strong>${fmt(currentSpending)}</strong>/year is within
          the <strong>${confPct}%</strong> confidence threshold. The estimated sustainable spending level is
          ${floorPrefix}<strong>${fmt(sustainableSpending)}</strong>/year${portClause} –
          giving you headroom of approximately <strong>${fmt(absDiff)}</strong>/year above your current target.`;
      } else {
        sustainBody = `To achieve <strong>${confPct}%</strong> confidence of never running out, the estimated
          sustainable spending level is <strong>${fmt(sustainableSpending)}</strong>/year${portClause} –
          approximately <strong>${fmt(absDiff)}</strong>/year below your current target of <strong>${fmt(currentSpending)}</strong>/year.
          Consider reducing discretionary spending or building a larger portfolio before retiring.`;
      }

      sustainHTML = `
        <section class="mc-section mc-sustain ${sClass}">
          <h4 class="mc-section-heading">Sustainable spending estimate</h4>
          <p>${sustainBody}</p>
          <p class="mc-sustain__note">All spending figures are in today's money (real, year-0 terms) and do not change with the Real/Nominal toggle above, which affects portfolio values only. Sustainable spending is estimated via bisection across 12 simulation runs; accuracy ±1%.</p>
        </section>`;
    }

    // ── 3. MEDIAN OUTCOME ─────────────────────────────────────────────────
    const p50Peak     = peak(p50);
    const p50Depletes = depletionYear(p50);
    let medianBody;
    if (p50Depletes) {
      const yearsEarly = lastYear - p50Depletes;
      medianBody = `In the median scenario, the portfolio is exhausted by
        <strong>${p50Depletes}</strong> – ${yearsEarly} year${yearsEarly !== 1 ? 's' : ''} before
        the end of the projection.`;
    } else {
      medianBody = `In the median scenario, your portfolio peaks at
        <strong>${fmt(p50Peak.value)}</strong> around ${p50Peak.year} and finishes at
        <strong>${fmt(p50[lastIdx])}</strong> in ${lastYear} (${modeLabel} terms).`;
    }

    const medianHTML = `
      <section class="mc-section">
        <h4 class="mc-section-heading">Median outcome</h4>
        <p>${medianBody}</p>
      </section>`;

    // ── 4. STRESS CASE (10th percentile) ──────────────────────────────────
    // Colour the stress card based on severity
    const p10FinalRatio  = openingPortfolio > 0 ? p10[lastIdx] / openingPortfolio : 1;
    const stressClass    = p10Depletes          ? 'mc-sustain--danger' :
                           p10FinalRatio < 0.20 ? 'mc-sustain--warn'   : '';

    let stressBody;
    if (p10Depletes) {
      const yearsEarly = lastYear - p10Depletes;
      // Estimate rough onset: find when p10 first dips below 50% of opening
      let onsetYear = null;
      for (let i = 0; i < p10.length; i++) {
        if (openingPortfolio > 0 && p10[i] < openingPortfolio * 0.5) {
          onsetYear = r.years[i];
          break;
        }
      }
      const onsetClause = onsetYear && onsetYear < p10Depletes
        ? ` Spending pressure typically emerges around <strong>${onsetYear}</strong> as the portfolio falls below half its starting value.`
        : '';
      stressBody = `In the bottom 10% of outcomes, the portfolio runs out by
        <strong>${p10Depletes}</strong> – ${yearsEarly} year${yearsEarly !== 1 ? 's' : ''} before
        the end of the projection.${onsetClause} This scenario typically reflects a combination
        of poor early returns and elevated inflation (sequence risk).`;
    } else {
      stressBody = `In a poor returns environment (10th percentile), your portfolio
        retains <strong>${fmt(p10[lastIdx])}</strong> by ${lastYear} (${modeLabel} terms). While
        significantly below the median, the plan remains solvent throughout the
        projection even under this stress scenario.`;
    }

    const stressHTML = `
      <section class="mc-section${stressClass ? ' mc-sustain ' + stressClass : ''}">
        <h4 class="mc-section-heading">10th percentile – stress case</h4>
        <p>${stressBody}</p>
      </section>`;

    // ── 5. OPTIMISTIC CASE (90th percentile) ──────────────────────────────
    const p90Final      = p90[lastIdx];
    const isStrongUpside = p90Final > openingPortfolio * 2;
    const legacyNote    = p90Final > 500_000
      ? ' This would leave meaningful wealth to pass on or deploy in later life.'
      : '';
    const optimisticHeadingStyle = isStrongUpside
      ? ' style="color:var(--green-2, #16a34a)"'
      : '';

    const optimisticHTML = `
      <section class="mc-section">
        <h4 class="mc-section-heading"${optimisticHeadingStyle}>90th percentile – optimistic case</h4>
        <p>In a favourable environment (90th percentile), your portfolio reaches
        <strong>${fmt(p90Final)}</strong> by ${lastYear} (${modeLabel} terms).${legacyNote}</p>
      </section>`;

    // ── 6. INTERQUARTILE RANGE ────────────────────────────────────────────
    const p25Final = p25[lastIdx];
    const p75Final = p75[lastIdx];
    const iqrWide  = (p75Final - p25Final) / Math.max(p50[lastIdx], 1) > 1.5;
    const iqrHTML = `
      <section class="mc-section">
        <h4 class="mc-section-heading">Middle 50% of outcomes</h4>
        <p>In the central half of all simulated paths, your portfolio finishes
        between <strong>${fmt(p25Final)}</strong> (25th percentile) and <strong>${fmt(p75Final)}</strong>
        (75th percentile) by ${lastYear} (${modeLabel} terms). A tight range
        indicates lower dispersion risk; a wide range reflects sensitivity to
        return sequence.${
          iqrWide
            ? ' The spread here is wide – your outcome is highly sensitive to which sequence of returns materialises early in retirement.'
            : ''
        }</p>
      </section>`;

    // ── 7. EARLIEST DEPLETION ─────────────────────────────────────────────
    let earliestHTML = '';
    if (r.earliestDepletion) {
      const yearsIn = r.earliestDepletion - firstYear;
      earliestHTML = `
        <section class="mc-section">
          <h4 class="mc-section-heading">Earliest depletion</h4>
          <p>In the worst-case paths, funds could be exhausted as early as
          <strong>${r.earliestDepletion}</strong> – just ${yearsIn} year${yearsIn !== 1 ? 's' : ''}
          into the projection. This typically occurs when a severe market downturn
          coincides with high spending in the early years of retirement.</p>
        </section>`;
    }

    // ── 8. RUIN PROBABILITY BY DECADE ─────────────────────────────────────
    let decadeRows = '';
    if (r.survivalByYear && r.years) {
      const decades = [2030, 2040, 2050, 2060, 2070].filter(
        y => y >= firstYear && y <= lastYear
      );
      decadeRows = decades.map(decadeYear => {
        const yi = r.years.indexOf(decadeYear);
        if (yi === -1) return '';
        const survivalRate = r.survivalByYear[yi] / r.simCount;
        const colour =
          survivalRate >= 0.95 ? 'var(--color-success, #16a34a)' :
          survivalRate >= 0.80 ? 'var(--color-warn,    #d97706)' :
                                 'var(--color-danger,  #dc2626)';
        return `<div class="mc-decade-row">
          <span class="mc-decade-row__year">${decadeYear}</span>
          <span class="mc-decade-row__bar-wrap">
            <span class="mc-decade-row__bar" style="width:${(survivalRate * 100).toFixed(1)}%;background:${colour}"></span>
          </span>
          <span class="mc-decade-row__pct" style="color:${colour}">${fmtPct(survivalRate)}</span>
        </div>`;
      }).join('');
    }

    const ruinHTML = decadeRows ? `
      <section class="mc-section">
        <h4 class="mc-section-heading">Portfolio survival by year</h4>
        <p style="margin-bottom:12px">Percentage of the ${r.simCount.toLocaleString('en-GB')} simulated paths
        where the portfolio remains above zero at each point in time.</p>
        <div class="mc-decade-chart">${decadeRows}</div>
      </section>` : '';

    // ── 9. ACTIONS ────────────────────────────────────────────────────────
    const actionItems = [];

    if (_spendingContext && _spendingContext.sustainableSpending != null) {
      const { currentSpending, sustainableSpending, sustainableIsFloor } = _spendingContext;
      const gap = sustainableSpending - currentSpending;

      if (!sustainableIsFloor && gap < 0) {
        // Spending exceeds sustainable — compute rounded reduction needed
        const reduction = roundToNearest(Math.abs(gap), 500);
        actionItems.push(`Reduce spending by approximately <strong>${fmt(reduction)}/year</strong> to reach the 90% confidence threshold — bringing your target to around <strong>${fmt(currentSpending - reduction)}/year</strong>.`);
      } else if (gap > 0 && !sustainableIsFloor) {
        // There's headroom — note it as a positive option
        const headroomRounded = roundToNearest(gap, 500);
        actionItems.push(`You have approximately <strong>${fmt(headroomRounded)}/year</strong> of headroom — modest spending increases remain within the 90% confidence band.`);
      }
    }

    // Sequence risk / early depletion warning → suggest cash buffer
    if (r.earliestDepletion) {
      const yearsIn = r.earliestDepletion - firstYear;
      if (yearsIn <= 15) {
        actionItems.push(`The earliest stress-case depletion is <strong>${r.earliestDepletion}</strong> (${yearsIn} years in) — maintaining a 2–3 year cash buffer would reduce sequence-of-returns risk in early retirement.`);
      }
    }

    // Sub-95% success rate: suggest short withdrawal delay
    if (r.successRate >= 0.80 && r.successRate < 0.95) {
      actionItems.push(`Delaying withdrawals by 1–2 years would allow the portfolio to compound further and meaningfully improve survival odds across the distribution.`);
    }

    // Wide IQR: note diversification or flexibility value
    if (iqrWide) {
      actionItems.push(`The wide spread between the 25th and 75th percentile outcomes suggests a flexible spending strategy — reducing withdrawals by 10–15% in years with negative real returns — would materially improve the downside.`);
    }

    let actionsHTML = '';
    if (actionItems.length === 0) {
      // Strong plan — no material actions needed
      actionsHTML = `
        <section class="mc-section mc-sustain mc-sustain--safe">
          <h4 class="mc-section-heading">Plan assessment</h4>
          <p>No material changes needed. Your plan is resilient across the full range of simulated scenarios — success rate, sustainable spending, and stress-case outcomes are all within strong bounds.</p>
        </section>`;
    } else {
      const liItems = actionItems.map(item => `<li>${item}</li>`).join('');
      const isWarn  = r.successRate < 0.95 || (headroom !== null && headroom < 0);
      const aClass  = isWarn ? 'mc-sustain--warn' : 'mc-sustain--safe';
      actionsHTML = `
        <section class="mc-section mc-sustain ${aClass}">
          <h4 class="mc-section-heading">How to improve this plan</h4>
          <ul style="margin:6px 0 0;padding-left:18px;font-size:14px;line-height:1.7;color:var(--text,#374151)">${liItems}</ul>
        </section>`;
    }

    // ── 10. ASSUMPTIONS NOTE ──────────────────────────────────────────────
    const eVolRaw  = r.equityVol    != null ? r.equityVol    : 0.16;
    const iVolRaw  = r.inflationVol != null ? r.inflationVol : 0.015;
    const eVol     = (eVolRaw * 100).toFixed(0);
    const iVol     = (iVolRaw * 100).toFixed(1);
    const volLabel =
      eVolRaw >= 0.18 ? 'an aggressive set of assumptions reflecting very high uncertainty' :
      eVolRaw >= 0.14 ? 'a cautious set of assumptions reflecting elevated uncertainty in both markets and inflation' :
                        'a moderate set of assumptions broadly consistent with long-run historical ranges';

    const assumHTML = `
      <section class="mc-section mc-section--muted">
        <h4 class="mc-section-heading">Assumptions</h4>
        <p>This stress test uses <strong>${eVol}%</strong> equity volatility and <strong>${iVol}%</strong> inflation
        volatility – ${volLabel}. Each of the
        ${r.simCount.toLocaleString('en-GB')} paths independently samples annual
        returns and inflation, compounding uncertainty across the full
        ${r.years.length}-year projection.
        All values shown in ${modeLabel} terms.</p>
      </section>`;

    el.innerHTML = introHTML + keyFiguresHTML + verdictHTML + sustainHTML +
                   medianHTML + stressHTML + optimisticHTML + iqrHTML +
                   earliestHTML + ruinHTML + actionsHTML + assumHTML;
  }

  window.RetireMCRender = { setResults, render, setReal };

})();
