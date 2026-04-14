(function () {
  const C = window.RetireCalc;

  // ─────────────────────────────────────────────────────────────────────────
  // withdrawalStrategy
  //
  // Decides HOW MUCH to draw from each wrapper for each person, given:
  //   - the remaining spending shortfall after guaranteed income (SP, salary,
  //     interest draws, dividends) and cash have already been applied
  //   - current balances (already mutated by cash draw — do not re-apply)
  //   - tax position inputs needed by the tax-aware strategy
  //   - SIPP lock flags and wrapper draw orders
  //
  // Returns { p1Drawn, p2Drawn } — each is:
  //   { GIA, SIPP, ISA, Cash, sippTaxable }
  //
  // The 'Cash' field in the return is always 0 here — cash draws are handled
  // upstream in engine.js (Priority 2) and merged back in after this call.
  //
  // Engine contract: engine.js calls this once per year after cash draw,
  // before growth and tax. It then merges the returned draws into p1Drawn /
  // p2Drawn and adds p1CashDrawn / p2CashDrawn back onto .Cash.
  //
  // Input shape:
  // {
  //   mode,            — '50/50' | 'taxAware'
  //   shortfall,       — remaining spend gap after guaranteed income and cash
  //   p1Bal, p2Bal,    — balances (already cash-reduced; mutated in place by C.withdraw)
  //   p1WrapperOrder,  — ['GIA','SIPP','ISA'] (Cash and locked SIPP already filtered)
  //   p2WrapperOrder,
  //   p1SIPPLocked,    — boolean
  //   p2SIPPLocked,
  //   // tax-aware only:
  //   p1PAHeadroom,    — max additional taxable income that fits within PA
  //   p2PAHeadroom,
  // }
  // ─────────────────────────────────────────────────────────────────────────

  function withdrawalStrategy({
    mode,
    shortfall,
    p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1PAHeadroom, p2PAHeadroom,
  }) {
    const zero = () => ({ GIA: 0, SIPP: 0, ISA: 0, Cash: 0, sippTaxable: 0 });

    // ── 50/50 mode ────────────────────────────────────────────────────────
    if (mode === '50/50') {
      // Purely mechanical equal split — no tax logic applied.
      const p1Half = shortfall / 2;
      const p1Drawn = C.withdraw(p1Bal, p1WrapperOrder, p1Half);
      const p1Unmet = Math.max(0, p1Half - p1Drawn.GIA - p1Drawn.SIPP - p1Drawn.ISA);

      const p2Drawn = C.withdraw(p2Bal, p2WrapperOrder, shortfall / 2 + p1Unmet);
      const p2Unmet = Math.max(
        0,
        (shortfall / 2 + p1Unmet) - p2Drawn.GIA - p2Drawn.SIPP - p2Drawn.ISA
      );

      if (p2Unmet > 0) {
        const extra = C.withdraw(p1Bal, p1WrapperOrder, p2Unmet);
        p1Drawn.GIA        += extra.GIA;
        p1Drawn.SIPP       += extra.SIPP;
        p1Drawn.ISA        += extra.ISA;
        p1Drawn.sippTaxable += extra.sippTaxable;
      }

      return { p1Drawn, p2Drawn };
    }

    // ── Tax-aware mode ────────────────────────────────────────────────────
    if (shortfall <= 0) {
      // No portfolio draw needed.
      return { p1Drawn: zero(), p2Drawn: zero() };
    }

    // Step 1: draw SIPP to fill each person's PA headroom — only if accessible.
    // Gross SIPP needed = headroom / SIPP_TAXABLE_RATIO (75% of draw is taxable income).
    const p1SippTarget = (!p1SIPPLocked && p1PAHeadroom > 0)
      ? Math.min(p1PAHeadroom / C.SIPP_TAXABLE_RATIO, p1Bal.SIPP || 0)
      : 0;
    const p2SippTarget = (!p2SIPPLocked && p2PAHeadroom > 0)
      ? Math.min(p2PAHeadroom / C.SIPP_TAXABLE_RATIO, p2Bal.SIPP || 0)
      : 0;

    const p1Drawn = C.withdraw(p1Bal, ['SIPP'], p1SippTarget);
    const p2Drawn = C.withdraw(p2Bal, ['SIPP'], p2SippTarget);

    // Step 2: remaining shortfall split proportionally by remaining PA headroom.
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

    const p1RemDrawn = C.withdraw(p1Bal, p1NonSippOrder, remShortfall * p1Weight);
    const p2RemDrawn = C.withdraw(p2Bal, p2NonSippOrder, remShortfall * p2Weight);

    // Merge non-SIPP draws into result.
    p1Drawn.GIA += p1RemDrawn.GIA;
    p1Drawn.ISA += p1RemDrawn.ISA;
    p2Drawn.GIA += p2RemDrawn.GIA;
    p2Drawn.ISA += p2RemDrawn.ISA;

    // Step 3: fallback — unmet demand goes to the other person, including SIPP as last resort.
    const p1Unmet = Math.max(
      0,
      remShortfall * p1Weight - p1RemDrawn.GIA - p1RemDrawn.ISA - p1RemDrawn.SIPP
    );
    const p2Unmet = Math.max(
      0,
      remShortfall * p2Weight - p2RemDrawn.GIA - p2RemDrawn.ISA - p2RemDrawn.SIPP
    );

    if (p1Unmet > 0) {
      const extra = C.withdraw(p2Bal, p2WrapperOrder, p1Unmet);
      p2Drawn.GIA        += extra.GIA;
      p2Drawn.ISA        += extra.ISA;
      p2Drawn.SIPP       += extra.SIPP;
      p2Drawn.sippTaxable += extra.sippTaxable;
    }
    if (p2Unmet > 0) {
      const extra = C.withdraw(p1Bal, p1WrapperOrder, p2Unmet);
      p1Drawn.GIA        += extra.GIA;
      p1Drawn.ISA        += extra.ISA;
      p1Drawn.SIPP       += extra.SIPP;
      p1Drawn.sippTaxable += extra.sippTaxable;
    }

    // Step 4: final catch-all — if shortfall still unmet, draw more SIPP as last resort.
    const totalDrawn = p1Drawn.GIA + p1Drawn.SIPP + p1Drawn.ISA
                     + p2Drawn.GIA + p2Drawn.SIPP + p2Drawn.ISA;
    const stillUnmet = Math.max(0, shortfall - totalDrawn);

    if (stillUnmet > 0) {
      const p1Extra = !p1SIPPLocked
        ? C.withdraw(p1Bal, ['SIPP'], stillUnmet / 2)
        : { SIPP: 0, sippTaxable: 0 };
      const p2Share = stillUnmet / 2 + Math.max(0, stillUnmet / 2 - p1Extra.SIPP);
      const p2Extra = !p2SIPPLocked
        ? C.withdraw(p2Bal, ['SIPP'], p2Share)
        : { SIPP: 0, sippTaxable: 0 };

      p1Drawn.SIPP        += p1Extra.SIPP;
      p1Drawn.sippTaxable += p1Extra.sippTaxable;
      p2Drawn.SIPP        += p2Extra.SIPP;
      p2Drawn.sippTaxable += p2Extra.sippTaxable;

      const p2StillUnmet = Math.max(0, stillUnmet / 2 - p2Extra.SIPP);
      if (p2StillUnmet > 0 && !p1SIPPLocked) {
        const p1Last = C.withdraw(p1Bal, ['SIPP'], p2StillUnmet);
        p1Drawn.SIPP        += p1Last.SIPP;
        p1Drawn.sippTaxable += p1Last.sippTaxable;
      }
    }

    return { p1Drawn, p2Drawn };
  }

  window.RetireWithdrawalStrategy = { withdrawalStrategy };
})();
