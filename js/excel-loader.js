(function () {

  // ─────────────────────────────────────────────
  // LABEL → ELEMENT ID MAP
  // Parameters sheet col A (human label) → DOM element ID
  // ─────────────────────────────────────────────
  const PARAM_MAP = {
    'Person 1 – birth year':                    'woodyDOB',
    'Person 2 – birth year':                    'heidiDOB',
    'Person 1 name':                            'p1name',
    'Person 2 name':                            'p2name',
    'Start year':                               'startYear',
    'End year':                                 'endYear',
    'Annual household spending (£)':            'spending',
    'Step-down at age 75 (%)':                  'stepDownPct',
    'Person 1 – gross annual salary (£)':       'woodySalary',
    'Person 1 – salary stop age':               'woodySalaryStopAge',
    'Gross annual salary (£)':                  'heidiSalary',
    'Stop age':                                 'heidiSalaryStopAge',
    'Person 1 – start age':                     'woodySPAge',
    'Person 1 – annual amount (£)':             'woodySP',
    'Person 2 – start age':                     'heidiSPAge',
    'Person 2 – annual amount (£)':             'heidiSP',
    'Portfolio growth (%/yr)':                  'growth',
    'Inflation (%/yr)':                         'inflation',
    'Threshold uprating mode':                  'thresholdMode',
    'Uprate from year':                         'thresholdFromYearVal',
    'Enable bed-and-ISA':                       'bniEnabled',
    'Person 1 GIA→ISA per year (£)':            'bniWoodyGIA',
    'Person 2 GIA→ISA per year (£)':            'bniHeidiGIA',
  };

  const REQUIRED_LABELS = [
    'Person 1 – birth year',
    'Person 2 – birth year',
    'Start year',
    'End year',
    'Annual household spending (£)',
  ];

  // ─────────────────────────────────────────────
  // PUBLIC: trigger file picker
  // ─────────────────────────────────────────────
  function openFilePicker() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.xlsx,.xls';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (file) readFile(file);
      document.body.removeChild(input);
    });
    input.click();
  }

  // ─────────────────────────────────────────────
  // READ FILE via SheetJS
  // ─────────────────────────────────────────────
  function readFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb   = XLSX.read(data, { type: 'array' });
        parseWorkbook(wb);
      } catch (err) {
        console.error('Excel load error:', err);
        alert('Failed to read Excel file – see console.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ─────────────────────────────────────────────
  // PARSE WORKBOOK
  // ─────────────────────────────────────────────
  function parseWorkbook(wb) {
    const accounts = parseAccounts(wb);
    const params   = parseParams(wb);
    const errors   = validate(accounts, params);

    if (errors.length) {
      alert('Excel load issues:\n\n' + errors.join('\n'));
      return;
    }

    document.dispatchEvent(new CustomEvent('excel-loaded', {
      detail: { accounts, params }
    }));
  }

  // ─────────────────────────────────────────────
  // SHEET 1 — Accounts
  // Columns: name, wrapper, owner, value,
  //          equities, bonds, cashlike, cash,
  //          rate, monthlyDraw, notes (ignored)
  // Row 1 = title, Row 2 = headers, Row 3+ = data
  // ─────────────────────────────────────────────
  function parseAccounts(wb) {
    const sheet = wb.Sheets['Accounts'];
    if (!sheet) throw new Error('No "Accounts" sheet found.');

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      range:  2,
    });

    const accounts = [];
    const validWrappers = new Set(['ISA', 'SIPP', 'GIA', 'Cash']);

    rows.forEach((row) => {
      const name    = String(row[0] || '').trim();
      const wrapper = String(row[1] || '').trim();
      if (!name || !validWrappers.has(wrapper)) return;

      const owner       = String(row[2] || 'p1').trim();
      const value       = parseNum(row[3]);
      const equities    = parseNum(row[4]);
      const bonds       = parseNum(row[5]);
      const cashlike    = parseNum(row[6]);
      const cash        = parseNum(row[7]);
      const rate        = row[8] !== '' && row[8] !== null ? parseNum(row[8]) : null;
      const monthlyDraw = row[9] !== '' && row[9] !== null ? parseNum(row[9]) : null;

      accounts.push({ name, wrapper, owner, value,
        alloc: { equities, bonds, cashlike, cash },
        rate, monthlyDraw });
    });

    return accounts;
  }

  // ─────────────────────────────────────────────
  // SHEET 2 — Parameters
  // Reads cells directly by address to avoid SheetJS merged-cell row issues.
  // Supports both formats:
  //   Old: col A = label, col B = key(elementId), col C = value
  //   New: col A = label, col B = value
  // Auto-detected by col B row-2 header text.
  // ─────────────────────────────────────────────
  function parseParams(wb) {
    const sheet = wb.Sheets['Parameters'];
    if (!sheet) throw new Error('No "Parameters" sheet found.');

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const maxRow = range.e.r;

    // Read header row (row index 1 = sheet row 2) col B to detect format
    const headerBCell = sheet[XLSX.utils.encode_cell({ r: 1, c: 1 })];
    const headerB = headerBCell ? String(headerBCell.v || '') : '';
    const isOldFormat = headerB.toLowerCase().includes('key');

    const params = {};

    for (let r = 2; r <= maxRow; r++) {
      const cellA = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
      const cellB = sheet[XLSX.utils.encode_cell({ r, c: 1 })];
      const cellC = sheet[XLSX.utils.encode_cell({ r, c: 2 })];

      const valB = cellB ? cellB.v : null;
      const valC = cellC ? cellC.v : null;

      if (isOldFormat) {
        const key = String(valB || '').trim();
        if (!key) continue;
        params[key] = (valC !== null && valC !== undefined) ? valC : '';
      } else {
        const valA = cellA ? cellA.v : null;
        const label = String(valA || '').trim();
        if (!label) continue;
        const elementId = PARAM_MAP[label];
        if (!elementId) continue;
        params[elementId] = (valB !== null && valB !== undefined) ? valB : '';
      }
    }

    return params;
  }

  // ─────────────────────────────────────────────
  // VALIDATE
  // ─────────────────────────────────────────────
  function validate(accounts, params) {
    const errors = [];
    const validWrappers = new Set(['ISA', 'SIPP', 'GIA', 'Cash']);
    const validOwners   = new Set(['p1', 'p2']);

    accounts.forEach((a, i) => {
      const r = i + 3;
      if (!validWrappers.has(a.wrapper))
        errors.push(`Accounts row ${r}: Wrapper "${a.wrapper}" must be ISA, SIPP, GIA, or Cash`);
      if (!validOwners.has(a.owner))
        errors.push(`Accounts row ${r}: Owner "${a.owner}" must be p1 or p2`);
      const allocTotal = a.alloc.equities + a.alloc.bonds + a.alloc.cashlike + a.alloc.cash;
      if (Math.abs(allocTotal - 100) > 1)
        errors.push(`Accounts row ${r} (${a.name}): Allocation totals ${allocTotal.toFixed(1)}%, must be 100%`);
    });

    const requiredIds = ['woodyDOB', 'heidiDOB', 'startYear', 'endYear', 'spending'];
    requiredIds.forEach(id => {
      if (params[id] === undefined || params[id] === '')
        errors.push(`Parameters: Missing required field "${id}"`);
    });

    return errors;
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────
  function parseNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  window.RetireExcelLoader = { openFilePicker };
})();
