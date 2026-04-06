(function () {
  const D = window.RetireData;
  const C = window.RetireCalc;
  const R = window.RetireRender;

  const STORAGE_KEY = 'rukRetirementSetup';

  const state = {
    portfolioAccounts: [],
    nextId: 1,
  };

  // ─────────────────────────────
  // SAFE HELPERS
  // ─────────────────────────────
  function safeEl(id) {
    return document.getElementById(id);
  }

  function safeValue(id) {
    const el = safeEl(id);
    return el ? el.value : '';
  }

  function safeNumber(val) {
    const n = Number(val);
    return isNaN(n) ? 0 : n;
  }

  function formatCurrency(val) {
    return D?.formatCurrency
      ? D.formatCurrency(val)
      : (val || 0).toLocaleString('en-GB');
  }

  // ─────────────────────────────
  // SAVE FEEDBACK TOAST
  // ─────────────────────────────
  function showToast(msg, isError) {
    let toast = safeEl('rup-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'rup-toast';
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        padding: '10px 18px',
        borderRadius: '6px',
        fontFamily: 'sans-serif',
        fontSize: '14px',
        color: '#fff',
        zIndex: 9999,
        opacity: 0,
        transition: 'opacity 0.2s ease',
        pointerEvents: 'none',
      });
      document.body.appendChild(toast);
    }

    toast.textContent = msg;
    toast.style.background = isError ? '#c0392b' : '#27ae60';
    toast.style.opacity = 1;

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = 0; }, 2500);
  }

  // ─────────────────────────────
  // DOM → STATE
  // ─────────────────────────────
  function syncAccountsFromDOM() {
    const rows = document.querySelectorAll('#acct-tbody tr');
    const updated = [];

    rows.forEach((row) => {
      const id = Number(row.id.replace('acct-row-', ''));

      const get = (field) =>
        row.querySelector(`[data-field="${field}"]`);

      updated.push({
        id,
        name: get('name')?.value || '',
        wrapper: get('wrapper')?.value || 'GIA',
        owner: get('owner')?.value || 'p1',
        value: safeNumber(D.parseCurrency(get('value')?.value || 0)),
        alloc: {
          equities: safeNumber(get('equities')?.value),
          bonds: safeNumber(get('bonds')?.value),
          cashlike: safeNumber(get('cashlike')?.value),
          cash: safeNumber(get('cash')?.value),
        },
        rate: get('rate')?.value ? safeNumber(get('rate').value) : null,
        monthlyDraw: get('monthlyDraw')?.value
          ? safeNumber(D.parseCurrency(get('monthlyDraw').value))
          : null,
      });
    });

    state.portfolioAccounts = updated;
  }

  // ─────────────────────────────
  // SETUP STATE
  // ─────────────────────────────
  function readSetupInputs() {
    return {
      version: 1,
      people: {
        p1: {
          name: safeValue('sp-p1name').trim(),
          age: safeNumber(safeValue('sp-p1age')),
        },
        p2: {
          name: safeValue('sp-p2name').trim(),
          age: safeNumber(safeValue('sp-p2age')),
        },
      },
      accounts: state.portfolioAccounts,
    };
  }

  function applySetupInputs(data) {
    if (!data) return;

    if (safeEl('sp-p1name')) safeEl('sp-p1name').value = data.people?.p1?.name || '';
    if (safeEl('sp-p1age')) safeEl('sp-p1age').value = data.people?.p1?.age || '';
    if (safeEl('sp-p2name')) safeEl('sp-p2name').value = data.people?.p2?.name || '';
    if (safeEl('sp-p2age')) safeEl('sp-p2age').value = data.people?.p2?.age || '';

    state.portfolioAccounts = data.accounts || [];

    state.nextId =
      Math.max(1, ...state.portfolioAccounts.map((a) => a.id || 0)) + 1;

    const tbody = safeEl('acct-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';

    const ownerNames = getOwnerNames();
    state.portfolioAccounts.forEach((acc) => {
      R.renderAccountRow(acc, ownerNames);
      R.updateRowBadge(acc);
      R.applyWrapperFieldState(acc);
    });

    refreshSetupSummary();
  }

  // ─────────────────────────────
  // CALCULATOR INITIALISATION
  // ─────────────────────────────
  function initialiseCalculatorFromSetup(data) {
    if (!data?.accounts) return;

    const totals = {
      woody: { ISA: 0, SIPP: 0, GIA: 0, Cash: 0 },
      heidi: { ISA: 0, SIPP: 0, GIA: 0, Cash: 0 },
    };

    data.accounts.forEach((acc) => {
      const ownerKey = acc.owner === 'p1' ? 'woody' : 'heidi';
      const wrapper = acc.wrapper || 'GIA';

      totals[ownerKey][wrapper] =
        (totals[ownerKey][wrapper] || 0) + (acc.value || 0);
    });

    const map = [
      ['woodyISA', totals.woody.ISA],
      ['woodySIPP', totals.woody.SIPP],
      ['woodyGIA', totals.woody.GIA],
      ['woodyCash', totals.woody.Cash],
      ['heidiISA', totals.heidi.ISA],
      ['heidiSIPP', totals.heidi.SIPP],
      ['heidiGIA', totals.heidi.GIA],
      ['heidiCash', totals.heidi.Cash],
    ];

    map.forEach(([id, val]) => {
      const el = safeEl(id);
      if (el) el.value = formatCurrency(val);
    });
  }

  // ─────────────────────────────
  // SAVE / LOAD
  // ─────────────────────────────
  function saveSetup() {
    syncAccountsFromDOM();
    const data = readSetupInputs();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      console.log('Saved:', data);
      showToast('Setup saved ✓');
    } catch (err) {
      console.error(err);
      showToast('Save failed – see console', true);
    }
  }

  function loadSetup() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return showToast('No saved setup found.', true);

    try {
      const data = JSON.parse(raw);
      applySetupInputs(data);
      showToast('Setup loaded ✓');
    } catch (err) {
      console.error(err);
      showToast('Load failed – see console', true);
    }
  }

  // ─────────────────────────────
  // OWNER NAMES
  // ─────────────────────────────
  function getOwnerNames() {
    return [
      safeValue('sp-p1name').trim() || 'Person 1',
      safeValue('sp-p2name').trim() || 'Person 2',
    ];
  }

  // ─────────────────────────────
  // ACCOUNTS
  // ─────────────────────────────
  function addAccount() {
    const acc = {
      id: state.nextId++,
      name: '',
      wrapper: 'GIA',
      owner: 'p1',
      value: 0,
      alloc: { equities: 100, bonds: 0, cashlike: 0, cash: 0 },
      rate: null,
      monthlyDraw: null,
    };
    state.portfolioAccounts.push(acc);
    R.renderAccountRow(acc, getOwnerNames());
    R.updateRowBadge(acc);
    R.applyWrapperFieldState(acc);
    refreshSetupSummary();
  }

  function removeAccount(el) {
    const row = el.closest('tr');
    if (row) row.remove();
    syncAccountsFromDOM();
    refreshSetupSummary();
  }

  // ─────────────────────────────
  // SUMMARY
  // ─────────────────────────────
  function refreshSetupSummary() {
    const summary = C.summarisePortfolio(state.portfolioAccounts);
    R.renderSetupSummary(summary);
  }

  // ─────────────────────────────
  // EVENTS
  // ─────────────────────────────
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;

    const action = el.dataset.action;

    if (action === 'add-account') return addAccount();
    if (action === 'remove-account') return removeAccount(el);

    if (action === 'save-setup') return saveSetup();
    if (action === 'load-setup') return loadSetup();

    if (action === 'continue-to-main') {
      syncAccountsFromDOM();

      const data = readSetupInputs();
      console.log('HANDOFF →', data);

      initialiseCalculatorFromSetup(data);

      safeEl('setup-page').style.display = 'none';
      safeEl('main-app').style.display = '';
    }

    if (action === 'back-to-setup') {
      safeEl('setup-page').style.display = '';
      safeEl('main-app').style.display = 'none';
    }
  });

  refreshSetupSummary();
})();
