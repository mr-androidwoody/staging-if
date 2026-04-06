(function () {
  const D = window.RetireData;
  const C = window.RetireCalc;
  const R = window.RetireRender;

  const STORAGE_KEY = 'rukRetirementSetup';

  const state = {
    rows: [],
    viewPerson: 'both',
    useReal: true,
    activeTab: 'charts',
    charts: { incomeChart: null, taxChart: null, wealthChart: null },
    portfolioAccounts: [],
    nextId: 1,
    interestAccounts: [],
  };

  function ownerNames() {
    return [
      document.getElementById('sp-p1name').value.trim() || 'Person 1',
      document.getElementById('sp-p2name').value.trim() || 'Person 2',
    ];
  }

  function getInputValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  function getCurrencyValue(id) {
    return D.parseCurrency(getInputValue(id));
  }

  function getIntValue(id) {
    return parseInt(String(D.parseCurrency(getInputValue(id))), 10) || 0;
  }

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
        value: D.parseCurrency(get('value')?.value || 0),
        alloc: {
          equities: Number(get('equities')?.value || 0),
          bonds: Number(get('bonds')?.value || 0),
          cashlike: Number(get('cashlike')?.value || 0),
          cash: Number(get('cash')?.value || 0),
        },
        rate: get('rate')?.value ? Number(get('rate').value) : null,
        monthlyDraw: get('monthlyDraw')?.value
          ? D.parseCurrency(get('monthlyDraw').value)
          : null,
      });
    });

    state.portfolioAccounts = updated;
  }

  function readSetupInputs() {
    return {
      version: 1,
      people: {
        p1: {
          name: document.getElementById('sp-p1name').value.trim(),
          age: parseInt(document.getElementById('sp-p1age').value, 10) || 0,
        },
        p2: {
          name: document.getElementById('sp-p2name').value.trim(),
          age: parseInt(document.getElementById('sp-p2age').value, 10) || 0,
        },
      },
      accounts: state.portfolioAccounts,
    };
  }

  function initialiseCalculatorFromSetup(data) {
    if (!data || !data.accounts) return;

    const totals = {
      woody: { ISA: 0, SIPP: 0, GIA: 0, Cash: 0 },
      heidi: { ISA: 0, SIPP: 0, GIA: 0, Cash: 0 },
    };

    data.accounts.forEach((acc) => {
      const ownerKey = acc.owner === 'p1' ? 'woody' : 'heidi';
      const wrapper = acc.wrapper || 'GIA';

      if (!totals[ownerKey][wrapper]) {
        totals[ownerKey][wrapper] = 0;
      }

      totals[ownerKey][wrapper] += acc.value || 0;
    });

    const map = [
      { id: 'woodyISA', value: totals.woody.ISA },
      { id: 'woodySIPP', value: totals.woody.SIPP },
      { id: 'woodyGIA', value: totals.woody.GIA },
      { id: 'woodyCash', value: totals.woody.Cash },
      { id: 'heidiISA', value: totals.heidi.ISA },
      { id: 'heidiSIPP', value: totals.heidi.SIPP },
      { id: 'heidiGIA', value: totals.heidi.GIA },
      { id: 'heidiCash', value: totals.heidi.Cash },
    ];

    map.forEach(({ id, value }) => {
      const el = document.getElementById(id);
      if (el) {
        el.value = D.formatCurrency(value || 0);
      }
    });
  }

  function saveSetup() {
    syncAccountsFromDOM();
    const data = readSetupInputs();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    console.log('Saved setup:', data);
  }

  function loadSetup() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return alert('No saved setup found.');

    try {
      const data = JSON.parse(raw);
      if (!data || data.version !== 1) throw new Error();
      applySetupInputs(data);
    } catch {
      alert('Saved data is corrupted.');
    }
  }

  function refreshSetupSummary() {
    R.refreshOwnerOptions(state.portfolioAccounts, ownerNames());
    const summary = C.summarisePortfolio(state.portfolioAccounts);
    R.renderSetupSummary(summary);

    state.portfolioAccounts.forEach((acc) => {
      R.updateRowBadge(acc);
      R.applyWrapperFieldState(acc);
    });
  }

  function addAccount(data) {
    const result = C.addAccount(state.portfolioAccounts, state.nextId, data);
    state.portfolioAccounts = result.accounts;
    state.nextId = result.nextId;

    R.renderAccountRow(result.account, ownerNames());
    R.updateRowBadge(result.account);

    refreshSetupSummary();
  }

  function removeAccount(id) {
    state.portfolioAccounts = C.removeAccount(state.portfolioAccounts, id);
    const row = document.getElementById('acct-row-' + id);
    if (row) row.remove();
    refreshSetupSummary();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;

    const action = el.dataset.action;

    if (action === 'add-account') addAccount({});
    if (action === 'remove-account') removeAccount(Number(el.dataset.accountId));
    if (action === 'save-setup') saveSetup();
    if (action === 'load-setup') loadSetup();

    if (action === 'continue-to-main') {
      syncAccountsFromDOM();
      const setupData = readSetupInputs();
      initialiseCalculatorFromSetup(setupData);

      document.getElementById('setup-page').style.display = 'none';
      document.getElementById('main-app').style.display = '';
    }

    if (action === 'back-to-setup') {
      document.getElementById('setup-page').style.display = '';
      document.getElementById('main-app').style.display = 'none';
    }
  });

  refreshSetupSummary();
})();