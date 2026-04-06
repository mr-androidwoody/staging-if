(function () {
  const D = window.RetireData;

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
    const accounts   = parseAccounts(wb);
    const params     = parseParams(wb);
    const errors     = validate(accounts, params);

    if (errors.length) {
      alert('Excel load issues:\n\n' + errors.join('\n'));
      return;
    }

    // Fire event so app.js can consume
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
      range:  2,   // skip row 1 (title) and row 2 (headers), 0-indexed so range:2 = start at row 3
    });

    const accounts = [];
    const validWrappers = new Set(['ISA', 'SIPP', 'GIA', 'Cash']);

    rows.forEach((row, i) => {
      const name    = String(row[0] || '').trim();
      const wrapper = String(row[1] || '').trim();
      // Skip blank rows and legend/reference rows (no valid wrapper)
      if (!name) return;
      if (!validWrappers.has(wrapper)) return;

      const owner      = String(row[2] || 'p1').trim();
      const value      = parseNum(row[3]);
      const equities   = parseNum(row[4]);
      const bonds      = parseNum(row[5]);
      const cashlike   = parseNum(row[6]);
      const cash       = parseNum(row[7]);
      const rate       = row[8] !== '' && row[8] !== null ? parseNum(row[8]) : null;
      const monthlyDraw = row[9] !== '' && row[9] !== null ? parseNum(row[9]) : null;

      accounts.push({ name, wrapper, owner, value,
        alloc: { equities, bonds, cashlike, cash },
        rate, monthlyDraw });
    });

    return accounts;
  }

  // ─────────────────────────────────────────────
  // SHEET 2 — Parameters
  // Columns: label, key, value, notes
  // Row 1 = title, Row 2 = headers, Row 3+ = data
  // Section header rows have no key — skip them
  // ─────────────────────────────────────────────
  function parseParams(wb) {
    const sheet = wb.Sheets['Parameters'];
    if (!sheet) throw new Error('No "Parameters" sheet found.');

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      range:  2,
    });

    const params = {};
    rows.forEach((row) => {
      const key = String(row[1] || '').trim();
      if (!key) return;           // section header row — no key
      const val = row[2];
      params[key] = val;
    });

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

    const requiredParams = ['woodyDOB', 'heidiDOB', 'startYear', 'endYear', 'spending'];
    requiredParams.forEach(k => {
      if (params[k] === undefined || params[k] === '')
        errors.push(`Parameters: Missing required key "${k}"`);
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
