(function () {
  const D = window.RetireData;

  function calcCGT(taxableIncomeAfterPA, taxableGain, TAX) {
    if (taxableGain <= 0) return 0;
    const basicBand = Math.max(0, TAX.basicLimit - TAX.PA);
    const basicUsed = Math.min(Math.max(0, taxableIncomeAfterPA), basicBand);
    const basicRemaining = Math.max(0, basicBand - basicUsed);
    const atBasic = Math.min(taxableGain, basicRemaining);
    const atHigher = Math.max(0, taxableGain - atBasic);
    return atBasic * TAX.cgtRates.basic + atHigher * TAX.cgtRates.higher;
  }

  function calcEmployeeNI(employmentIncome, TAX, atOrAboveStatePensionAge) {
    if (atOrAboveStatePensionAge || employmentIncome <= 0) return 0;
    const pt = TAX.ni.primaryThreshold;
    const uel = TAX.ni.upperEarningsLimit;
    const mainBand = Math.max(0, Math.min(employmentIncome, uel) - pt);
    const upperBand = Math.max(0, employmentIncome - uel);
    return mainBand * TAX.ni.mainRate + upperBand * TAX.ni.upperRate;
  }

  function calcIncomeTaxDetailed(nonSavings, savings, dividends, TAX) {
    nonSavings = nonSavings || 0;
    savings = savings || 0;
    dividends = dividends || 0;
    const totalIncome = nonSavings + savings + dividends;

    if (totalIncome <= 0) {
      return {
        tax: 0,
        taxableIncomeAfterPA: 0,
        paUsed: 0,
        nsNet: 0,
        savNet: 0,
        divNet: 0,
        savTaxable: 0,
        divTaxable: 0
      };
    }

    const pa = totalIncome > TAX.taperStart
      ? Math.max(0, TAX.PA - Math.floor((totalIncome - TAX.taperStart) / 2))
      : TAX.PA;

    let paRem = pa;
    const nsNet = Math.max(0, nonSavings - paRem);
    paRem = Math.max(0, paRem - nonSavings);

    const savNet = Math.max(0, savings - paRem);
    paRem = Math.max(0, paRem - savings);

    const divNet = Math.max(0, dividends - paRem);

    const srsAvail = Math.max(0, TAX.srsLimit - nsNet);
    const srsCover = Math.min(savNet, srsAvail);
    const savAfterSRS = savNet - srsCover;

    const totalIncomeForPSA = nonSavings + savings + dividends;
    const psa = totalIncomeForPSA <= TAX.basicLimit
      ? TAX.psa.basic
      : totalIncomeForPSA <= TAX.additionalThreshold
        ? TAX.psa.higher
        : TAX.psa.additional;

    const psaCover = Math.min(savAfterSRS, psa);
    const savTaxable = Math.max(0, savAfterSRS - psaCover);
    const divTaxable = Math.max(0, divNet - TAX.dividendAllowance);

    const basicBand = Math.max(0, TAX.basicLimit - TAX.PA);
    const higherBand = Math.max(0, TAX.additionalThreshold - TAX.basicLimit);

    let nsTax = 0;
    {
      let r = nsNet;
      const b = Math.min(r, basicBand);
      nsTax += b * TAX.nonSavingsRates.basic;
      r -= b;

      if (r > 0) {
        const h = Math.min(r, higherBand);
        nsTax += h * TAX.nonSavingsRates.higher;
        r -= h;
        if (r > 0) nsTax += r * TAX.nonSavingsRates.additional;
      }
    }

    let savTax = 0;
    if (savTaxable > 0) {
      let r = savTaxable;
      const used = nsNet;
      const bLeft = Math.max(0, basicBand - used);
      const b = Math.min(r, bLeft);
      savTax += b * TAX.savingsRates.basic;
      r -= b;

      if (r > 0) {
        const hLeft = Math.max(0, higherBand - Math.max(0, used - basicBand));
        const h = Math.min(r, hLeft);
        savTax += h * TAX.savingsRates.higher;
        r -= h;
        if (r > 0) savTax += r * TAX.savingsRates.additional;
      }
    }

    let divTax = 0;
    if (divTaxable > 0) {
      let r = divTaxable;
      const used = nsNet + savNet;
      const bLeft = Math.max(0, basicBand - used);
      const b = Math.min(r, bLeft);
      divTax += b * TAX.dividendRates.basic;
      r -= b;

      if (r > 0) {
        const hLeft = Math.max(0, higherBand - Math.max(0, used - basicBand));
        const h = Math.min(r, hLeft);
        divTax += h * TAX.dividendRates.higher;
        r -= h;
        if (r > 0) divTax += r * TAX.dividendRates.additional;
      }
    }

    return {
      tax: nsTax + savTax + divTax,
      taxableIncomeAfterPA: nsNet + savNet + divNet,
      paUsed: pa - paRem,
      nsNet,
      savNet,
      divNet,
      savTaxable,
      divTaxable
    };
  }

  function calcIncomeTax(nonSavings, savings, dividends, TAX) {
    return calcIncomeTaxDetailed(nonSavings, savings, dividends, TAX).tax;
  }

  function interestEffective(annualPct) {
    const daily = annualPct / 100 / 365;
    return Math.pow(1 + daily, 365) - 1;
  }

  function withdraw(balances, order, needed) {
    const drawn = { Cash: 0, GIA: 0, SIPP: 0, ISA: 0, sippTaxable: 0 };
    let rem = needed;

    for (const w of order) {
      if (rem <= 0) break;
      const avail = balances[w] || 0;
      if (avail <= 0) continue;

      const take = Math.min(avail, rem);
      drawn[w] += take;
      balances[w] -= take;
      rem -= take;

      if (w === 'SIPP') drawn.sippTaxable += take * 0.75;
    }

    return drawn;
  }

  function growBalances(b, growthRate) {
    b.Cash = b.Cash || 0;
    b.GIA = (b.GIA || 0) * (1 + growthRate);
    b.SIPP = (b.SIPP || 0) * (1 + growthRate);
    b.ISA = (b.ISA || 0) * (1 + growthRate);
  }

  function totalBal(b) {
    return (b.Cash || 0) + (b.GIA || 0) + (b.SIPP || 0) + (b.ISA || 0);
  }

  function getOrder(inputs, prefix, slots) {
    const o = [];
    for (let i = 1; i <= slots; i += 1) {
      o.push(inputs[prefix + 'Order' + i]);
    }
    return o;
  }

  function cloneAccounts(accounts) {
    return accounts.map((a) => ({ ...a, alloc: { ...a.alloc } }));
  }

  function addAccount(accounts, nextId, data) {
    const id = nextId;
    const acc = data ? { id, ...data } : {
      id,
      name: '',
      wrapper: 'ISA',
      owner: 'Woody',
      value: 0,
      alloc: { equities: 100, bonds: 0, cashlike: 0, cash: 0 },
      rate: null,
      monthlyDraw: null
    };

    return {
      account: acc,
      accounts: accounts.concat(acc),
      nextId: nextId + 1
    };
  }

  function removeAccount(accounts, id) {
    return accounts.filter((a) => a.id !== id);
  }

  function updateAccount(accounts, id, field, value) {
    return accounts.map((a) => {
      if (a.id !== id) return a;

      const acc = { ...a, alloc: { ...a.alloc } };

      if (D.ALLOC_CLASSES.includes(field)) {
        acc.alloc[field] = parseFloat(value) || 0;
      } else if (field === 'value') {
        acc[field] = D.parseCurrency(value);
      } else if (field === 'rate') {
        acc[field] = value === '' ? null : parseFloat(value) || 0;
      } else if (field === 'monthlyDraw') {
        acc[field] = value === '' ? null : D.parseCurrency(value);
      } else {
        acc[field] = value;
      }

      if (field === 'wrapper' && D.FIXED_CASH_WRAPPERS.has(value)) {
        D.ALLOC_CLASSES.forEach((cls) => {
          acc.alloc[cls] = cls === 'cash' ? 100 : 0;
        });
      }

      return acc;
    });
  }

  function summarisePortfolio(accounts) {
    const total = accounts.reduce((s, a) => s + (a.value || 0), 0);

    const wrapperTotals = {};
    D.WRAPPERS.forEach((w) => {
      wrapperTotals[w] = accounts
        .filter((a) => a.wrapper === w)
        .reduce((s, a) => s + (a.value || 0), 0);
    });

    const overallAllocation = {};
    D.ALLOC_CLASSES.forEach((cls) => {
      overallAllocation[cls] = total > 0
        ? accounts.reduce((s, a) => s + (a.value || 0) * (a.alloc[cls] || 0) / 100, 0) / total * 100
        : 0;
    });

    return {
      total,
      wrapperTotals,
      overallAllocation,
      overallPct: Object.values(overallAllocation).reduce((s, v) => s + v, 0)
    };
  }

  function buildInterestAccounts(accounts) {
    return accounts
      .filter((a) => a.rate !== null && a.rate !== undefined && a.rate !== '' && Number(a.rate) > 0)
      .map((a) => ({
        name: a.name,
        owner: a.owner,
        wrapper: a.wrapper,
        rate: a.rate,
        monthlyDraw: a.monthlyDraw,
        balance: a.value || 0
      }));
  }

  function continueToMainData(accounts, p1, p2) {
    const sumBy = (owner, wrapper) =>
      accounts
        .filter((a) => a.owner === owner && a.wrapper === wrapper)
        .reduce((s, a) => s + (a.value || 0), 0);

    const total = accounts.reduce((s, a) => s + (a.value || 0), 0);

    return {
      mainValues: {
        woodySIPP: sumBy(p1, 'SIPP'),
        heidiSIPP: sumBy(p2, 'SIPP'),
        woodyISA: sumBy(p1, 'ISA'),
        heidiISA: sumBy(p2, 'ISA'),
        woodyGIA: sumBy(p1, 'GIA'),
        heidiGIA: sumBy(p2, 'GIA'),
        woodyCash: sumBy(p1, 'Cash'),
        heidiCash: sumBy(p2, 'Cash')
      },
      banner: { total, nAccts: accounts.length },
      interestAccounts: []
    };
  }

  function runProjection(inputs) {
    const startYear = inputs.startYear;
    const endYear = inputs.endYear;
    const woodyDOB = inputs.woodyDOB;
    const heidiDOB = inputs.heidiDOB;
    const spending = inputs.spending;
    const stepDownPct = inputs.stepDownPct;
    const heidiSalary = inputs.heidiSalary;
    const heidiSalaryStop = inputs.heidiSalaryStopAge;
    const woodySPAge = inputs.woodySPAge;
    const woodySPAmt = inputs.woodySP;
    const heidiSPAge = inputs.heidiSPAge;
    const heidiSPAmt = inputs.heidiSP;
    const growth = inputs.growth / 100;
    const inflation = inputs.inflation / 100;
    const thresholdMode = inputs.thresholdMode;
    const thresholdFromYear = inputs.thresholdFromYearVal || 2028;
    const bniEnabled = !!inputs.bniEnabled;
    const bniWoodyGIA = bniEnabled ? inputs.bniWoodyGIA : 0;
    const bniHeidiGIA = bniEnabled ? inputs.bniHeidiGIA : 0;
    const intAccts = cloneAccounts(inputs.interestAccounts || []).map((a) => ({
      ...a,
      balance: a.balance || 0
    }));

    const woodyBal = {
      Cash: inputs.woodyCash,
      GIA: inputs.woodyGIA,
      SIPP: inputs.woodySIPP,
      ISA: inputs.woodyISA
    };

    const heidiBal = {
      Cash: inputs.heidiCash,
      GIA: inputs.heidiGIA,
      SIPP: inputs.heidiSIPP,
      ISA: inputs.heidiISA
    };

    const woodyOrder = getOrder(inputs, 'woody', 4);
    const heidiOrder = getOrder(inputs, 'heidi', 4);

    let woodyGIACost = woodyBal.GIA;
    let heidiGIACost = heidiBal.GIA;
    const p1name = inputs.p1name || 'Woody';

    const startBal = {
      'Woody Cash': woodyBal.Cash,
      'Woody GIA': woodyBal.GIA,
      'Woody SIPP': woodyBal.SIPP,
      'Woody ISA': woodyBal.ISA,
      'Heidi Cash': heidiBal.Cash,
      'Heidi GIA': heidiBal.GIA,
      'Heidi SIPP': heidiBal.SIPP,
      'Heidi ISA': heidiBal.ISA
    };

    intAccts.forEach((a) => {
      startBal[a.name + ' (' + a.owner + ')'] = a.balance;
    });

    const depletions = {};
    let cumInfl = 1;
    const rows = [];

    for (let year = startYear; year <= endYear; year += 1) {
      const woodyAge = year - woodyDOB;
      const heidiAge = year - heidiDOB;
      cumInfl *= (1 + inflation);
      const realDeflator = 1 / cumInfl;

      const woodySP = woodyAge >= woodySPAge ? woodySPAmt * cumInfl : 0;
      const heidiSP = heidiAge >= heidiSPAge ? heidiSPAmt * cumInfl : 0;
      const heidiSalInc = (heidiSalaryStop && heidiAge < heidiSalaryStop) ? heidiSalary * cumInfl : 0;
      const target = (spending * cumInfl) * (
        stepDownPct > 0 && woodyAge >= 75 ? (1 - stepDownPct / 100) : 1
      );

      let uprateFactor = 1;
      if (thresholdMode === 'always') {
        uprateFactor = cumInfl;
      } else if (thresholdMode === 'fromYear' && year >= thresholdFromYear) {
        uprateFactor = cumInfl / Math.pow(1 + inflation, thresholdFromYear - startYear);
      }

      const baseRules = D.getTaxRulesForYear(year);
      const effThresholds = D.upratedTaxRules(baseRules, uprateFactor);
      const effCGTExempt = effThresholds.cgtExempt;

      let bniCGTBill = 0;
      let bniCGTUnpaid = 0;

      if (bniEnabled) {
        let woodyBniCGT = 0;
        let heidiBniCGT = 0;

        if (bniWoodyGIA > 0 && woodyBal.GIA > 0) {
          const transfer = Math.min(bniWoodyGIA, woodyBal.GIA, D.ISA_ALLOWANCE);
          const giaGain = Math.max(0, woodyBal.GIA - woodyGIACost);
          const taxableGain = Math.max(
            0,
            transfer * (woodyBal.GIA > 0 ? giaGain / woodyBal.GIA : 0) - effCGTExempt
          );

          woodyBniCGT = taxableGain > 0 ? calcCGT(0, taxableGain, effThresholds) : 0;
          bniCGTBill += woodyBniCGT;

          const costFrac = woodyBal.GIA > 0 ? transfer / woodyBal.GIA : 1;
          woodyBal.GIA -= transfer;
          woodyBal.ISA += transfer;
          woodyGIACost = Math.max(0, woodyGIACost * (1 - costFrac));
        }

        if (bniHeidiGIA > 0 && heidiBal.GIA > 0) {
          const transfer = Math.min(bniHeidiGIA, heidiBal.GIA, D.ISA_ALLOWANCE);
          const giaGain = Math.max(0, heidiBal.GIA - heidiGIACost);
          const taxableGain = Math.max(
            0,
            transfer * (heidiBal.GIA > 0 ? giaGain / heidiBal.GIA : 0) - effCGTExempt
          );

          heidiBniCGT = taxableGain > 0 ? calcCGT(0, taxableGain, effThresholds) : 0;
          bniCGTBill += heidiBniCGT;

          const costFrac = heidiBal.GIA > 0 ? transfer / heidiBal.GIA : 1;
          heidiBal.GIA -= transfer;
          heidiBal.ISA += transfer;
          heidiGIACost = Math.max(0, heidiGIACost * (1 - costFrac));
        }

        if (woodyBniCGT > 0) {
          const fromWoodyCash = Math.min(woodyBniCGT, woodyBal.Cash || 0);
          woodyBal.Cash -= fromWoodyCash;
          bniCGTUnpaid += woodyBniCGT - fromWoodyCash;
        }

        if (heidiBniCGT > 0) {
          const fromHeidiCash = Math.min(heidiBniCGT, heidiBal.Cash || 0);
          heidiBal.Cash -= fromHeidiCash;
          bniCGTUnpaid += heidiBniCGT - fromHeidiCash;
        }
      }

      let intDrawTotal = 0;
      let woodyIntDraw = 0;
      let heidiIntDraw = 0;
      let woodyIntTaxable = 0;
      let heidiIntTaxable = 0;

      intAccts.forEach((a) => {
        if (a.balance <= 0) return;

        const effectiveRate = interestEffective(a.rate);
        const interestEarned = a.balance * effectiveRate;
        const annualTarget = (a.monthlyDraw || 0) * 12;
        const isP1 = a.owner === p1name;

        if (annualTarget <= 0) {
          a.balance += interestEarned;
          if (a.wrapper === 'GIA') {
            if (isP1) woodyIntTaxable += interestEarned;
            else heidiIntTaxable += interestEarned;
          }
          return;
        }

        const drawActual = Math.min(annualTarget, a.balance + interestEarned);
        const interestDrawn = Math.min(drawActual, interestEarned);

        a.balance -= Math.max(0, drawActual - interestDrawn);
        a.balance += interestEarned - interestDrawn;

        intDrawTotal += drawActual;
        if (isP1) woodyIntDraw += drawActual;
        else heidiIntDraw += drawActual;

        if (a.wrapper === 'GIA') {
          if (isP1) woodyIntTaxable += interestEarned;
          else heidiIntTaxable += interestEarned;
        }

        const key = a.name + ' (' + a.owner + ')';
        if (!depletions[key] && startBal[key] > 0 && a.balance <= 0) {
          depletions[key] = {
            year,
            age: year - (isP1 ? woodyDOB : heidiDOB)
          };
        }
      });

      const guaranteed = woodySP + heidiSP + heidiSalInc + intDrawTotal;
      let shortfall = Math.max(0, target - guaranteed + bniCGTUnpaid);

      let cashDrawn = 0;
      let woodyCashDrawn = 0;
      let heidiCashDrawn = 0;

      if (shortfall > 0) {
        const totalCash = (woodyBal.Cash || 0) + (heidiBal.Cash || 0);
        cashDrawn = Math.min(shortfall, totalCash);

        const fromWoody = Math.min(cashDrawn, woodyBal.Cash || 0);
        const fromHeidi = Math.max(0, cashDrawn - fromWoody);

        woodyBal.Cash -= fromWoody;
        heidiBal.Cash = Math.max(0, (heidiBal.Cash || 0) - fromHeidi);

        woodyCashDrawn = fromWoody;
        heidiCashDrawn = fromHeidi;
        shortfall -= cashDrawn;
      }

      const wrapperOrder = woodyOrder.filter((w) => w !== 'Cash');
      const heidiWrapperOrder = heidiOrder.filter((w) => w !== 'Cash');

      const woodyHalf = shortfall / 2;
      const woodyDrawn = withdraw(woodyBal, wrapperOrder, woodyHalf);
      const woodyUnmet = Math.max(
        0,
        woodyHalf - woodyDrawn.GIA - woodyDrawn.SIPP - woodyDrawn.ISA
      );

      const heidiDrawn = withdraw(heidiBal, heidiWrapperOrder, shortfall / 2 + woodyUnmet);
      const heidiUnmet = Math.max(
        0,
        (shortfall / 2 + woodyUnmet) - heidiDrawn.GIA - heidiDrawn.SIPP - heidiDrawn.ISA
      );

      if (heidiUnmet > 0) {
        withdraw(woodyBal, wrapperOrder, heidiUnmet);
      }

      woodyDrawn.Cash += woodyCashDrawn;
      heidiDrawn.Cash += heidiCashDrawn;

      const woodyGIABalBefore = woodyBal.GIA || 0;
      const heidiGIABalBefore = heidiBal.GIA || 0;

      growBalances(woodyBal, growth);
      growBalances(heidiBal, growth);

      woodyGIACost += woodyGIABalBefore * growth;
      heidiGIACost += heidiGIABalBefore * growth;

      const woodyGIAGainFrac = woodyBal.GIA > 0
        ? Math.max(0, woodyBal.GIA - woodyGIACost) / woodyBal.GIA
        : 0;

      const heidiGIAGainFrac = heidiBal.GIA > 0
        ? Math.max(0, heidiBal.GIA - heidiGIACost) / heidiBal.GIA
        : 0;

      const woodyGIARealised = woodyDrawn.GIA * woodyGIAGainFrac;
      const heidiGIARealised = heidiDrawn.GIA * heidiGIAGainFrac;

      if (woodyGIABalBefore > 0 && woodyDrawn.GIA > 0) {
        woodyGIACost = Math.max(
          0,
          woodyGIACost * (1 - Math.min(1, woodyDrawn.GIA / woodyGIABalBefore))
        );
      }

      if (heidiGIABalBefore > 0 && heidiDrawn.GIA > 0) {
        heidiGIACost = Math.max(
          0,
          heidiGIACost * (1 - Math.min(1, heidiDrawn.GIA / heidiGIABalBefore))
        );
      }

      const woodyNonSavings = woodySP + woodyDrawn.sippTaxable;
      const heidiNonSavings = heidiSP + heidiSalInc + heidiDrawn.sippTaxable;

      const woodyIncome = calcIncomeTaxDetailed(woodyNonSavings, woodyIntTaxable, 0, effThresholds);
      const heidiIncome = calcIncomeTaxDetailed(heidiNonSavings, heidiIntTaxable, 0, effThresholds);

      const woodyIncomeTax = woodyIncome.tax;
      const heidiIncomeTax = heidiIncome.tax;

      const woodyCGT = calcCGT(
        woodyIncome.taxableIncomeAfterPA,
        Math.max(0, woodyGIARealised - effCGTExempt),
        effThresholds
      );

      const heidiCGT = calcCGT(
        heidiIncome.taxableIncomeAfterPA,
        Math.max(0, heidiGIARealised - effCGTExempt),
        effThresholds
      );

      const woodyNI = calcEmployeeNI(0, effThresholds, woodyAge >= woodySPAge);
      const heidiNI = calcEmployeeNI(heidiSalInc, effThresholds, heidiAge >= heidiSPAge);

      const woodyTax = woodyIncomeTax + woodyCGT + woodyNI;
      const heidiTax = heidiIncomeTax + heidiCGT + heidiNI;

      const woodyTaxInc = woodyNonSavings + woodyIntTaxable;
      const heidiTaxInc = heidiNonSavings + heidiIntTaxable;

      const checkMap = {
        'Woody Cash': woodyBal.Cash,
        'Woody GIA': woodyBal.GIA,
        'Woody SIPP': woodyBal.SIPP,
        'Woody ISA': woodyBal.ISA,
        'Heidi Cash': heidiBal.Cash,
        'Heidi GIA': heidiBal.GIA,
        'Heidi SIPP': heidiBal.SIPP,
        'Heidi ISA': heidiBal.ISA
      };

      Object.entries(checkMap).forEach(([key, bal]) => {
        if (!depletions[key] && startBal[key] > 0 && bal <= 0) {
          depletions[key] = {
            year,
            age: year - (key.startsWith('Woody') ? woodyDOB : heidiDOB)
          };
        }
      });

      const intBalWoody = intAccts
        .filter((a) => a.owner === p1name)
        .reduce((s, a) => s + a.balance, 0);

      const intBalHeidi = intAccts
        .filter((a) => a.owner !== p1name)
        .reduce((s, a) => s + a.balance, 0);

      rows.push({
        year,
        woodyAge,
        heidiAge,
        woodySP,
        heidiSP,
        heidiSalInc,
        intDrawTotal,
        woodyIntDraw,
        heidiIntDraw,
        cashDrawn,
        woodyIntTaxable,
        heidiIntTaxable,
        woodyDrawn,
        heidiDrawn,
        woodyTax,
        heidiTax,
        woodyTaxInc,
        heidiTaxInc,
        woodyIncomeTax,
        heidiIncomeTax,
        woodyCGT,
        heidiCGT,
        woodyNI,
        heidiNI,
        bniCGTBill: bniCGTBill || 0,
        totalPortfolio: totalBal(woodyBal) + totalBal(heidiBal) + intBalWoody + intBalHeidi,
        realDeflator,
        cumInfl,
        snap: {
          woodyCash: woodyBal.Cash,
          woodyIntBal: intBalWoody,
          woodyGIA: woodyBal.GIA,
          woodySIPP: woodyBal.SIPP,
          woodyISA: woodyBal.ISA,
          heidiCash: heidiBal.Cash,
          heidiIntBal: intBalHeidi,
          heidiGIA: heidiBal.GIA,
          heidiSIPP: heidiBal.SIPP,
          heidiISA: heidiBal.ISA
        }
      });
    }

    return { rows, depletions };
  }

  window.RetireCalc = {
    calcCGT,
    calcEmployeeNI,
    calcIncomeTaxDetailed,
    calcIncomeTax,
    interestEffective,
    addAccount,
    removeAccount,
    updateAccount,
    summarisePortfolio,
    buildInterestAccounts,
    continueToMainData,
    runProjection
  };
}());