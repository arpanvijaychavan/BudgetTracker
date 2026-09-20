const CATEGORIES = ["Shopping", "Groceries", "Dining", "Transportation", "Travel", "Activities", "Miscellaneous"];

const CATEGORY_COLORS = {
  Shopping: "var(--cat-shopping)",
  Groceries: "var(--cat-groceries)",
  Dining: "var(--cat-dining)",
  Transportation: "var(--cat-transportation)",
  Travel: "var(--cat-travel)",
  Activities: "var(--cat-activities)",
  Miscellaneous: "var(--cat-miscellaneous)",
};

const PRICE_BRACKETS = [
  { label: "$0 - $25", min: 0, max: 25 },
  { label: "$26 - $50", min: 26, max: 50 },
  { label: "$51 - $75", min: 51, max: 75 },
  { label: "$76 - $100", min: 76, max: 100 },
  { label: "$101 - $150", min: 101, max: 150 },
  { label: "$151 - $200", min: 151, max: 200 },
  { label: "$201 - $300", min: 201, max: 300 },
  { label: "$300+", min: 301, max: Infinity },
];

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Column-mapping fields the server's upload wizard understands (mirrors
// COLUMN_CANDIDATES in process_transactions.py).
const MAPPING_FIELDS = [
  { key: "date", label: "Date", required: true },
  { key: "merchant", label: "Merchant", required: false },
  { key: "description", label: "Description", required: false },
  { key: "amount", label: "Amount", required: false },
  { key: "debit", label: "Debit", required: false },
  { key: "credit", label: "Credit", required: false },
  { key: "type", label: "Type", required: false },
];

const state = {
  transactionsByMonth: {},
  budgets: {},
  currentMonth: null,
  currentYear: null,
  currentTab: "overview",
  sort: { key: "date", dir: "asc" },
  // categories: empty array means "all categories" (no filter applied).
  filters: { categories: [], priceBracket: "all", merchant: "" },
  // periodMode "month" uses currentMonth; "range" uses customRange instead,
  // for Overview and Transactions (Year tab always stays year-based).
  periodMode: "month",
  customRange: { start: null, end: null },
  categoryRules: {},
  merchantOverrides: {},
  rulesFilters: { keyword: "", override: "" },
  averagingRules: [],
  editingAveragingRuleId: null,
};

const uploadState = { uploadId: null, pendingMapping: null };

const el = {
  monthSelect: document.getElementById("month-select"),
  overviewBanner: document.getElementById("overview-banner"),
  overviewSummary: document.getElementById("overview-summary"),
  overviewTbody: document.getElementById("overview-tbody"),
  overviewTfoot: document.getElementById("overview-tfoot"),
  transactionsTbody: document.getElementById("transactions-tbody"),
  noTransactions: document.getElementById("no-transactions"),
  toast: document.getElementById("toast"),
  merchantFilter: document.getElementById("merchant-filter"),
  categoryFilterBtn: document.getElementById("category-filter-btn"),
  categoryFilterPanel: document.getElementById("category-filter-panel"),
  priceFilter: document.getElementById("price-filter"),
  clearFiltersBtn: document.getElementById("clear-filters-btn"),
  yearSelect: document.getElementById("year-select"),
  yearBanner: document.getElementById("year-banner"),
  yearSummary: document.getElementById("year-summary"),
  yearTbody: document.getElementById("year-tbody"),
  yearTfoot: document.getElementById("year-tfoot"),
  trendChart: document.getElementById("trend-chart"),
  trendTooltip: document.getElementById("trend-tooltip"),
  uploadBtn: document.getElementById("upload-btn"),
  uploadModal: document.getElementById("upload-modal"),
  uploadCloseBtn: document.getElementById("upload-close-btn"),
  uploadModalBody: document.getElementById("upload-modal-body"),
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  periodBar: document.getElementById("period-bar"),
  periodRangeControls: document.getElementById("period-range-controls"),
  rangeStart: document.getElementById("range-start"),
  rangeEnd: document.getElementById("range-end"),
  rangeApplyBtn: document.getElementById("range-apply-btn"),
  addExpenseBtn: document.getElementById("add-expense-btn"),
  deleteModal: document.getElementById("delete-modal"),
  deleteModalText: document.getElementById("delete-modal-text"),
  deleteModalCloseBtn: document.getElementById("delete-modal-close-btn"),
  deleteOneBtn: document.getElementById("delete-one-btn"),
  deleteGroupBtn: document.getElementById("delete-group-btn"),
  addExpenseModal: document.getElementById("add-expense-modal"),
  addExpenseCloseBtn: document.getElementById("add-expense-close-btn"),
  expenseDescription: document.getElementById("expense-description"),
  expenseAmount: document.getElementById("expense-amount"),
  expenseDate: document.getElementById("expense-date"),
  expenseCategory: document.getElementById("expense-category"),
  expenseSubmitBtn: document.getElementById("expense-submit-btn"),
  keywordRuleCount: document.getElementById("keyword-rule-count"),
  keywordRuleFilter: document.getElementById("keyword-rule-filter"),
  keywordRuleCategory: document.getElementById("keyword-rule-category"),
  keywordRuleInput: document.getElementById("keyword-rule-input"),
  keywordRuleAddBtn: document.getElementById("keyword-rule-add-btn"),
  keywordRulesList: document.getElementById("keyword-rules-list"),
  overrideRuleCount: document.getElementById("override-rule-count"),
  overrideRuleFilter: document.getElementById("override-rule-filter"),
  overrideRuleInput: document.getElementById("override-rule-input"),
  overrideRuleCategory: document.getElementById("override-rule-category"),
  overrideRuleAddBtn: document.getElementById("override-rule-add-btn"),
  overrideRulesTbody: document.getElementById("override-rules-tbody"),
  averagingRuleCount: document.getElementById("averaging-rule-count"),
  averagingRuleForm: document.getElementById("averaging-rule-form"),
  averagingRulesList: document.getElementById("averaging-rules-list"),
};

// ---------------------------------------------------------------------------
// Theme (light/dark) toggle - defaults to the OS preference, but an explicit
// choice here always overrides it and is remembered across visits.
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = "budget-tracker-theme";

function getEffectiveTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  el.themeToggleBtn.textContent = theme === "dark" ? "Light mode" : "Dark mode";
  // Canvas pixels don't respond to CSS variable changes on their own -
  // redraw the trend chart so its colors match the new theme immediately.
  if (state.currentYear) renderYearView();
}

function initTheme() {
  applyTheme(getEffectiveTheme());
  el.themeToggleBtn.addEventListener("click", () => {
    const next = getEffectiveTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  });
}

async function init() {
  initTheme();
  await loadData();

  el.logoutBtn.addEventListener("click", async () => {
    try {
      await fetch("/logout", { method: "POST" });
    } catch (err) {
      // Ignore - redirecting to /login below either way.
    }
    window.location.href = "/login";
  });

  el.monthSelect.addEventListener("change", () => {
    state.currentMonth = el.monthSelect.value;
    renderAll();
  });

  populateFilterSelects();

  el.merchantFilter.addEventListener("input", () => {
    state.filters.merchant = el.merchantFilter.value.trim().toLowerCase();
    renderTransactions();
  });

  el.categoryFilterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    el.categoryFilterPanel.hidden = !el.categoryFilterPanel.hidden;
  });

  document.addEventListener("click", (e) => {
    if (!el.categoryFilterPanel.hidden && !el.categoryFilterPanel.contains(e.target) && e.target !== el.categoryFilterBtn) {
      el.categoryFilterPanel.hidden = true;
    }
  });

  el.priceFilter.addEventListener("change", () => {
    state.filters.priceBracket = el.priceFilter.value;
    renderTransactions();
  });

  el.clearFiltersBtn.addEventListener("click", () => {
    state.filters = { categories: [], priceBracket: "all", merchant: "" };
    el.merchantFilter.value = "";
    el.priceFilter.value = "all";
    syncCategoryFilterCheckboxes();
    renderTransactions();
  });

  el.yearSelect.addEventListener("change", () => {
    state.currentYear = el.yearSelect.value;
    renderYearView();
  });

  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = { key, dir: "asc" };
      }
      renderTransactions();
    });
  });

  el.uploadBtn.addEventListener("click", openUploadModal);
  el.uploadCloseBtn.addEventListener("click", closeUploadModal);
  el.uploadModal.addEventListener("click", (e) => {
    if (e.target === el.uploadModal) closeUploadModal();
  });

  el.addExpenseBtn.addEventListener("click", openAddExpenseModal);
  el.addExpenseCloseBtn.addEventListener("click", closeAddExpenseModal);
  el.deleteModalCloseBtn.addEventListener("click", closeDeleteModal);
  el.deleteModal.addEventListener("click", (e) => {
    if (e.target === el.deleteModal) closeDeleteModal();
  });

  el.addExpenseModal.addEventListener("click", (e) => {
    if (e.target === el.addExpenseModal) closeAddExpenseModal();
  });
  el.expenseSubmitBtn.addEventListener("click", submitExpense);

  document.querySelectorAll(".period-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setPeriodMode(btn.dataset.mode));
  });
  el.rangeApplyBtn.addEventListener("click", applyCustomRange);

  el.trendChart.addEventListener("mousemove", handleTrendChartHover);
  el.trendChart.addEventListener("mouseleave", () => (el.trendTooltip.hidden = true));

  el.keywordRuleCategory.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
  el.overrideRuleCategory.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");

  el.keywordRuleAddBtn.addEventListener("click", submitAddKeywordRule);
  el.keywordRuleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAddKeywordRule();
  });
  el.keywordRuleFilter.addEventListener("input", () => {
    state.rulesFilters.keyword = el.keywordRuleFilter.value.trim().toLowerCase();
    renderRulesView();
  });

  el.overrideRuleAddBtn.addEventListener("click", submitAddOverrideRule);
  el.overrideRuleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAddOverrideRule();
  });
  el.overrideRuleFilter.addEventListener("input", () => {
    state.rulesFilters.override = el.overrideRuleFilter.value.trim().toLowerCase();
    renderRulesView();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.currentTab === "year") renderYearView();
    }, 150);
  });

  renderAll();
}

async function loadData() {
  const [transactions, budgets, categoryRules, merchantOverrides, averagingRules] = await Promise.all([
    fetchJson("../data/transactions.json"),
    fetchJson("../budgets.json"),
    fetchJson("../category_rules.json"),
    fetchJson("../merchant_overrides.json"),
    fetchJson("../averaging_rules.json"),
  ]);
  state.transactionsByMonth = transactions || {};
  state.budgets = budgets || {};
  state.categoryRules = categoryRules || {};
  state.merchantOverrides = merchantOverrides || {};
  state.averagingRules = averagingRules || [];

  const months = Object.keys(state.transactionsByMonth).sort();
  if (months.length === 0) {
    showToast("No transaction data found. Upload a statement to get started.", true);
    return;
  }

  populateMonthSelect(months);
  if (!state.currentMonth || !months.includes(state.currentMonth)) {
    state.currentMonth = getDefaultMonth(months);
  }
  el.monthSelect.value = state.currentMonth;

  const years = [...new Set(months.map((m) => m.split("-")[0]))].sort();
  populateYearSelect(years);
  if (!state.currentYear || !years.includes(state.currentYear)) {
    state.currentYear = getDefaultYear(years);
  }
  el.yearSelect.value = state.currentYear;
}

function redirectToLoginIfUnauthorized(res) {
  if (res.status === 401) {
    window.location.href = "/login";
    return true;
  }
  return false;
}

async function fetchJson(path) {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (redirectToLoginIfUnauthorized(res)) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

function populateMonthSelect(months) {
  el.monthSelect.innerHTML = "";
  months.forEach((month) => {
    const opt = document.createElement("option");
    opt.value = month;
    opt.textContent = formatMonthLabel(month);
    el.monthSelect.appendChild(opt);
  });
}

function getDefaultMonth(months) {
  const now = new Date();
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (months.includes(currentMonthStr)) return currentMonthStr;
  const pastMonths = months.filter((m) => m <= currentMonthStr);
  return pastMonths.length > 0 ? pastMonths[pastMonths.length - 1] : months[0];
}

function formatMonthLabel(month) {
  const [year, m] = month.split("-");
  const date = new Date(Number(year), Number(m) - 1, 1);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

function populateFilterSelects() {
  el.categoryFilterPanel.innerHTML = `
    <label class="multiselect-option">
      <input type="checkbox" id="category-filter-all" />
      All Categories
    </label>
    <div class="multiselect-divider"></div>
    ${CATEGORIES.map(
      (c) => `
      <label class="multiselect-option">
        <input type="checkbox" class="category-filter-option" value="${c}" />
        ${categoryDot(c)}${c}
      </label>
    `
    ).join("")}
  `;

  document.getElementById("category-filter-all").addEventListener("change", (e) => {
    state.filters.categories = [];
    syncCategoryFilterCheckboxes();
    renderTransactions();
  });

  el.categoryFilterPanel.querySelectorAll(".category-filter-option").forEach((cb) => {
    cb.addEventListener("change", () => {
      const { categories } = state.filters;
      if (cb.checked) {
        categories.push(cb.value);
      } else {
        state.filters.categories = categories.filter((c) => c !== cb.value);
      }
      syncCategoryFilterCheckboxes();
      renderTransactions();
    });
  });

  syncCategoryFilterCheckboxes();

  el.priceFilter.innerHTML = ["all", ...PRICE_BRACKETS.map((b) => b.label)]
    .map((label) => `<option value="${label}">${label === "all" ? "All Amounts" : label}</option>`)
    .join("");
}

function syncCategoryFilterCheckboxes() {
  const { categories } = state.filters;
  document.getElementById("category-filter-all").checked = categories.length === 0;
  el.categoryFilterPanel.querySelectorAll(".category-filter-option").forEach((cb) => {
    cb.checked = categories.includes(cb.value);
  });
  el.categoryFilterBtn.textContent =
    categories.length === 0
      ? "All Categories"
      : categories.length === 1
        ? categories[0]
        : `${categories.length} categories`;
}

function populateYearSelect(years) {
  el.yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
}

function getDefaultYear(years) {
  const currentYearStr = String(new Date().getFullYear());
  if (years.includes(currentYearStr)) return currentYearStr;
  const pastYears = years.filter((y) => y <= currentYearStr);
  return pastYears.length > 0 ? pastYears[pastYears.length - 1] : years[0];
}

function computeTopMonth(monthlyAmounts) {
  let bestIndex = -1;
  let bestAmount = 0;
  monthlyAmounts.forEach((amount, i) => {
    if (amount > bestAmount) {
      bestAmount = amount;
      bestIndex = i;
    }
  });
  return bestIndex === -1 ? null : { index: bestIndex, amount: bestAmount };
}

function matchesPriceBracket(amount, label) {
  const bracket = PRICE_BRACKETS.find((b) => b.label === label);
  if (!bracket) return true;
  const abs = Math.abs(amount);
  return abs >= bracket.min && abs <= bracket.max;
}

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${tab}-tab`);
  });
  // The period bar (Monthly / Custom range) only applies to Overview and
  // Transactions - the Year tab has its own year selector.
  el.periodBar.hidden = tab === "year";
  // The Year tab's container has zero width while hidden (display: none),
  // so the chart can only be sized correctly once it's actually visible.
  if (tab === "year") renderYearView();
}

function renderAll() {
  renderOverview();
  renderTransactions();
  renderYearView();
  renderRulesView();
}

// ---------------------------------------------------------------------------
// Period control (Monthly vs. Custom range) - shared by Overview and
// Transactions via currentTransactions().
// ---------------------------------------------------------------------------

function setPeriodMode(mode) {
  state.periodMode = mode;
  document.querySelectorAll(".period-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  el.periodRangeControls.hidden = mode !== "range";
  el.monthSelect.disabled = mode === "range";

  if (mode === "month" || (state.customRange.start && state.customRange.end)) {
    renderOverview();
    renderTransactions();
  }
}

function applyCustomRange() {
  const start = el.rangeStart.value;
  const end = el.rangeEnd.value;
  if (!start || !end) {
    showToast("Choose both a start and end date.", true);
    return;
  }
  if (start > end) {
    showToast("Start date must be before end date.", true);
    return;
  }
  state.customRange = { start, end };
  renderOverview();
  renderTransactions();
}

// ---------------------------------------------------------------------------
// Add expense (one-off, no statement involved)
// ---------------------------------------------------------------------------

function todayLocalDateString() {
  // Date.toISOString() converts to UTC first, which can shift "today" back
  // a day depending on timezone - build the string from local components
  // instead so the date input actually defaults to the user's today.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function openAddExpenseModal() {
  el.expenseCategory.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
  el.expenseDescription.value = "";
  el.expenseAmount.value = "";
  el.expenseDate.value = todayLocalDateString();
  el.addExpenseModal.hidden = false;
  el.expenseDescription.focus();
}

function closeAddExpenseModal() {
  el.addExpenseModal.hidden = true;
}

async function submitExpense() {
  const description = el.expenseDescription.value.trim();
  const amount = parseFloat(el.expenseAmount.value);
  const date = el.expenseDate.value;
  const category = el.expenseCategory.value;

  if (!description) {
    showToast("Enter a description.", true);
    return;
  }
  if (!amount || amount <= 0) {
    showToast("Enter a valid amount.", true);
    return;
  }
  if (!date) {
    showToast("Choose a date.", true);
    return;
  }

  try {
    const res = await fetch("/add-expense", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, description, amount, category }),
    });
    if (redirectToLoginIfUnauthorized(res)) return;
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || "Request failed");

    closeAddExpenseModal();
    await loadData();
    renderAll();
    showToast(
      result.split
        ? "Expense added and spread across months per your averaging rules."
        : "Expense added."
    );
  } catch (err) {
    showToast(err.message || "Failed to add expense. Is server.py running?", true);
  }
}

function categoryDot(category) {
  const color = CATEGORY_COLORS[category] || "var(--cat-miscellaneous)";
  return `<span class="cat-dot" style="background:${color}"></span>`;
}

function renderBudgetRow(category, budgeted, actual) {
  const diff = budgeted - actual;
  const pct = budgeted > 0 ? (actual / budgeted) * 100 : actual > 0 ? 100 : 0;
  const over = actual > budgeted;
  const wayOver = budgeted > 0 && pct >= 150;

  const overflowBadge = over ? `<span class="overflow-badge">${Math.round(pct)}%</span>` : "";

  return `
    <td data-label="Category"><span class="category-cell">${categoryDot(category)}${category}</span></td>
    <td data-label="Budgeted" class="amount">${formatCurrency(budgeted)}</td>
    <td data-label="Actual" class="amount">${formatCurrency(actual)}</td>
    <td data-label="Difference" class="amount ${over ? "over-budget" : "under-budget"}">${diff >= 0 ? "+" : "-"}${formatCurrency(Math.abs(diff))}</td>
    <td data-label="% Used" class="amount">${pct.toFixed(0)}%${overflowBadge}</td>
    <td data-label="Progress">
      <div class="progress-track">
        <div class="progress-fill ${over ? "over" : ""} ${wayOver ? "way-over" : ""}" style="width:${Math.min(pct, 100)}%"></div>
      </div>
    </td>
  `;
}

function renderYearView() {
  const year = state.currentYear;
  if (!year) return;
  const monthKeys = MONTH_ABBR.map((_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  const actualTotals = {};
  const budgetTotals = {};
  const monthlyTotals = {};
  const monthlyGrandTotals = monthKeys.map(() => 0);
  CATEGORIES.forEach((c) => {
    actualTotals[c] = 0;
    budgetTotals[c] = 0;
    monthlyTotals[c] = monthKeys.map(() => 0);
  });

  let anyBudgetMissing = false;
  monthKeys.forEach((monthKey, i) => {
    (state.transactionsByMonth[monthKey] || []).forEach((txn) => {
      if (!(txn.category in actualTotals)) return;
      actualTotals[txn.category] += txn.amount;
      monthlyTotals[txn.category][i] += txn.amount;
      monthlyGrandTotals[i] += txn.amount;
    });
    const budgetsForMonth = state.budgets[monthKey];
    if (!budgetsForMonth) {
      anyBudgetMissing = true;
      return;
    }
    CATEGORIES.forEach((c) => (budgetTotals[c] += budgetsForMonth[c] || 0));
  });

  el.yearTbody.innerHTML = "";
  let totalBudget = 0;
  let totalActual = 0;

  CATEGORIES.forEach((category) => {
    const budgeted = budgetTotals[category] || 0;
    const actual = actualTotals[category] || 0;
    totalBudget += budgeted;
    totalActual += actual;

    const topMonth = computeTopMonth(monthlyTotals[category]);
    const topMonthDisplay = topMonth
      ? `${MONTH_ABBR[topMonth.index]} <span class="text-muted">(${formatCurrency(topMonth.amount)})</span>`
      : "—";

    const tr = document.createElement("tr");
    tr.innerHTML = renderBudgetRow(category, budgeted, actual) + `<td data-label="Top Month">${topMonthDisplay}</td>`;
    el.yearTbody.appendChild(tr);
  });

  const totalDiff = totalBudget - totalActual;
  el.yearTfoot.innerHTML = `
    <tr>
      <td data-label="Category">Total</td>
      <td data-label="Budgeted" class="amount">${formatCurrency(totalBudget)}</td>
      <td data-label="Actual" class="amount">${formatCurrency(totalActual)}</td>
      <td data-label="Difference" class="amount ${totalActual > totalBudget ? "over-budget" : "under-budget"}">${totalDiff >= 0 ? "+" : "-"}${formatCurrency(Math.abs(totalDiff))}</td>
      <td data-label="% Used"></td>
      <td data-label="Progress"></td>
      <td data-label="Top Month"></td>
    </tr>
  `;

  el.yearSummary.innerHTML = `
    <div class="summary-card">
      <div class="label">Total Budgeted</div>
      <div class="value">${formatCurrency(totalBudget)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Total Spent</div>
      <div class="value">${formatCurrency(totalActual)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Remaining</div>
      <div class="value ${totalDiff < 0 ? "over-budget" : "under-budget"}">${formatCurrency(totalDiff)}</div>
    </div>
  `;

  el.yearBanner.innerHTML = anyBudgetMissing
    ? `<div class="banner">No budget entry found for one or more months in ${year}.</div>`
    : "";

  const monthlyBudgetTotals = monthKeys.map((monthKey) => {
    const b = state.budgets[monthKey];
    if (!b) return 0;
    return CATEGORIES.reduce((sum, c) => sum + (b[c] || 0), 0);
  });
  drawTrendChart(monthlyGrandTotals, monthlyBudgetTotals, getElapsedMonthCount(year));
}

function getElapsedMonthCount(year) {
  // Only fully-completed months count toward the "Avg" column - the
  // current month is still in progress, so including it would understate
  // the average (partial spend against a full month's budget).
  const now = new Date();
  const currentYear = now.getFullYear();
  const y = Number(year);
  if (y < currentYear) return 12;
  if (y > currentYear) return 0;
  return now.getMonth(); // 0-based index of the current month == count of prior completed months
}

let trendChartBars = [];

function compactCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function sizeCanvasToContainer(canvas, cssHeight) {
  // Canvases have a fixed pixel buffer independent of their displayed CSS
  // size. Stretching a low-res buffer to fill a wider container (or a
  // high-DPI/Retina screen) blurs it, so instead we size the buffer to
  // match the container's actual on-screen pixels (times devicePixelRatio)
  // and scale drawing operations back down to CSS-pixel coordinates.
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.parentElement.clientWidth || canvas.clientWidth || 900;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: cssWidth, height: cssHeight };
}

function average(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function drawTrendChart(actualByMonth, budgetByMonth, elapsedMonthCount = 12) {
  const canvas = el.trendChart;
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = sizeCanvasToContainer(canvas, 280);
  ctx.clearRect(0, 0, w, h);
  trendChartBars = [];

  const styles = getComputedStyle(document.documentElement);
  const gridColor = styles.getPropertyValue("--border").trim();
  const textColor = styles.getPropertyValue("--text-muted").trim();
  const labelColor = styles.getPropertyValue("--text").trim();
  const barColor = styles.getPropertyValue("--accent").trim();
  const overColor = styles.getPropertyValue("--red").trim();
  const avgBgColor = styles.getPropertyValue("--row-alt").trim();

  // Append one extra "Avg" group after the 12 months, summarizing the
  // typical month so far this year against the typical budget - only
  // months that have fully completed count (a partial current month would
  // understate the average).
  const labels = [...MONTH_ABBR, "Avg"];
  const amounts = [...actualByMonth, average(actualByMonth.slice(0, elapsedMonthCount))];
  const budgets = [...budgetByMonth, average(budgetByMonth.slice(0, elapsedMonthCount))];

  const padding = { top: 16, right: 16, bottom: 30, left: 56 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;
  const maxVal = Math.max(1, ...amounts, ...budgets) * 1.1;
  const groupW = chartW / labels.length;
  const barW = groupW * 0.55;

  // Horizontal gridlines + $ axis labels, drawn first so bars sit on top.
  const tickCount = 4;
  ctx.font = "11px sans-serif";
  for (let i = 0; i <= tickCount; i++) {
    const value = (maxVal / tickCount) * i;
    const y = padding.top + chartH - (chartH * i) / tickCount;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartW, y);
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    ctx.fillText(compactCurrency(value), padding.left - 8, y + 3);
  }

  // Shade the background behind the "Avg" group and draw a divider before
  // it, so it reads as a summary column rather than a 13th month.
  const avgGroupX = padding.left + (labels.length - 1) * groupW;
  ctx.fillStyle = avgBgColor;
  ctx.fillRect(avgGroupX, padding.top, groupW, chartH);
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(avgGroupX, padding.top);
  ctx.lineTo(avgGroupX, padding.top + chartH);
  ctx.stroke();

  labels.forEach((label, i) => {
    const amount = amounts[i];
    const budget = budgets[i];
    const isAvg = i === labels.length - 1;
    const x = padding.left + i * groupW + (groupW - barW) / 2;
    const barH = (amount / maxVal) * chartH;
    const over = budget > 0 && amount > budget;

    ctx.fillStyle = over ? overColor : barColor;
    ctx.fillRect(x, padding.top + chartH - barH, barW, Math.max(barH, amount > 0 ? 2 : 0));

    if (amount > 0) {
      ctx.fillStyle = labelColor;
      ctx.textAlign = "center";
      ctx.font = "10px sans-serif";
      ctx.fillText(compactCurrency(amount), x + barW / 2, padding.top + chartH - barH - 6);
    }

    if (budget > 0) {
      const budgetY = padding.top + chartH - (budget / maxVal) * chartH;
      ctx.strokeStyle = labelColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x - 4, budgetY);
      ctx.lineTo(x + barW + 4, budgetY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }

    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.font = isAvg ? "bold 11px sans-serif" : "11px sans-serif";
    ctx.fillText(label, x + barW / 2, padding.top + chartH + 18);

    const avgRangeLabel = elapsedMonthCount > 0
      ? `Average (${MONTH_ABBR[0]}–${MONTH_ABBR[elapsedMonthCount - 1]})`
      : "Average";

    trendChartBars.push({
      x: padding.left + i * groupW,
      width: groupW,
      month: isAvg ? avgRangeLabel : label,
      amount,
      budget,
      over,
      isAvg,
    });
  });
}

function handleTrendChartHover(e) {
  const canvas = el.trendChart;
  const rect = canvas.getBoundingClientRect();
  // Drawing coordinates are in CSS-pixel space (see sizeCanvasToContainer),
  // which maps 1:1 onto the bounding rect regardless of devicePixelRatio.
  const x = e.clientX - rect.left;

  const bar = trendChartBars.find((b) => x >= b.x && x < b.x + b.width);
  if (!bar) {
    el.trendTooltip.hidden = true;
    return;
  }

  const diff = bar.budget - bar.amount;
  const diffLabel = bar.budget > 0
    ? `${formatCurrency(Math.abs(diff))} ${diff >= 0 ? "under" : "over"} budget`
    : "no budget set";
  const spentLabel = bar.isAvg ? "Avg monthly spend" : "Spent";
  const budgetLabel = bar.isAvg ? "Avg monthly budget" : "Budget";

  el.trendTooltip.innerHTML = `
    <strong>${bar.month}</strong><br />
    ${spentLabel}: ${formatCurrency(bar.amount)}<br />
    ${bar.budget > 0 ? `${budgetLabel}: ${formatCurrency(bar.budget)}<br />` : ""}
    ${diffLabel}
  `;
  el.trendTooltip.style.left = `${e.clientX - rect.left}px`;
  el.trendTooltip.style.top = `${e.clientY - rect.top - 10}px`;
  el.trendTooltip.hidden = false;
}

function currentTransactions() {
  if (state.periodMode === "range" && state.customRange.start && state.customRange.end) {
    const { start, end } = state.customRange;
    // Date strings are "YYYY-MM-DD", which sorts/compares correctly as
    // plain strings, so no Date parsing is needed here.
    return Object.values(state.transactionsByMonth)
      .flat()
      .filter((t) => t.date >= start && t.date <= end);
  }
  return state.transactionsByMonth[state.currentMonth] || [];
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function getProratedBudgetForRange(startStr, endStr) {
  const totals = {};
  CATEGORIES.forEach((c) => (totals[c] = 0));

  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  if (isNaN(start) || isNaN(end) || start > end) return totals;

  // Walk month-by-month from the range's start to its end, prorating each
  // overlapping month's budget by the fraction of that month the range
  // actually covers - e.g. Jun 15-30 counts as half of June's budget.
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);

  while (cursor <= endMonth) {
    const y = cursor.getFullYear();
    const m = cursor.getMonth() + 1;
    const monthKey = `${y}-${String(m).padStart(2, "0")}`;
    const firstOfMonth = new Date(y, m - 1, 1);
    const lastOfMonth = new Date(y, m - 1, daysInMonth(y, m));
    const overlapStart = start > firstOfMonth ? start : firstOfMonth;
    const overlapEnd = end < lastOfMonth ? end : lastOfMonth;
    const overlapDays = Math.round((overlapEnd - overlapStart) / 86400000) + 1;

    const budgetForMonth = state.budgets[monthKey];
    if (budgetForMonth && overlapDays > 0) {
      const fraction = overlapDays / daysInMonth(y, m);
      CATEGORIES.forEach((c) => {
        totals[c] += (budgetForMonth[c] || 0) * fraction;
      });
    }

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return totals;
}

function rangeCoversMonthWithNoBudget(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor <= endMonth) {
    const monthKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    if (!state.budgets[monthKey]) return true;
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return false;
}

function computeCategoryTotals() {
  const totals = {};
  CATEGORIES.forEach((c) => (totals[c] = 0));
  currentTransactions().forEach((txn) => {
    totals[txn.category] = (totals[txn.category] || 0) + txn.amount;
  });
  return totals;
}

function renderOverview() {
  const isRange = state.periodMode === "range" && state.customRange.start && state.customRange.end;
  const budgetsForMonth = isRange
    ? getProratedBudgetForRange(state.customRange.start, state.customRange.end)
    : state.budgets[state.currentMonth] || {};
  const totals = computeCategoryTotals();

  el.overviewTbody.innerHTML = "";
  let totalBudget = 0;
  let totalActual = 0;

  CATEGORIES.forEach((category) => {
    const budgeted = budgetsForMonth[category] || 0;
    const actual = totals[category] || 0;
    totalBudget += budgeted;
    totalActual += actual;

    const tr = document.createElement("tr");
    tr.innerHTML = renderBudgetRow(category, budgeted, actual);
    el.overviewTbody.appendChild(tr);
  });

  const totalDiff = totalBudget - totalActual;
  el.overviewTfoot.innerHTML = `
    <tr>
      <td data-label="Category">Total</td>
      <td data-label="Budgeted" class="amount">${formatCurrency(totalBudget)}</td>
      <td data-label="Actual" class="amount">${formatCurrency(totalActual)}</td>
      <td data-label="Difference" class="amount ${totalActual > totalBudget ? "over-budget" : "under-budget"}">${totalDiff >= 0 ? "+" : "-"}${formatCurrency(Math.abs(totalDiff))}</td>
      <td data-label="% Used"></td>
      <td data-label="Progress"></td>
    </tr>
  `;

  el.overviewSummary.innerHTML = `
    <div class="summary-card">
      <div class="label">Total Budgeted</div>
      <div class="value">${formatCurrency(totalBudget)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Total Spent</div>
      <div class="value">${formatCurrency(totalActual)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Remaining</div>
      <div class="value ${totalDiff < 0 ? "over-budget" : "under-budget"}">${formatCurrency(totalDiff)}</div>
    </div>
  `;

  if (isRange) {
    el.overviewBanner.innerHTML = rangeCoversMonthWithNoBudget(state.customRange.start, state.customRange.end)
      ? `<div class="banner">One or more months in this range have no budget set - the budgeted total is partial.</div>`
      : "";
  } else {
    el.overviewBanner.innerHTML = !(state.currentMonth in state.budgets)
      ? `<div class="banner">No budget entry found for ${formatMonthLabel(state.currentMonth)}.</div>`
      : "";
  }
}

function updateClearFiltersButton() {
  const { categories, priceBracket, merchant } = state.filters;
  const activeCount = (categories.length > 0 ? 1 : 0) + (priceBracket !== "all" ? 1 : 0) + (merchant ? 1 : 0);
  el.clearFiltersBtn.hidden = activeCount === 0;
  el.clearFiltersBtn.textContent = activeCount > 0 ? `Clear filters (${activeCount})` : "Clear filters";
}

function renderTransactions() {
  updateClearFiltersButton();

  const { categories, priceBracket, merchant } = state.filters;
  const txns = currentTransactions().filter((txn) => {
    if (categories.length > 0 && !categories.includes(txn.category)) return false;
    if (priceBracket !== "all" && !matchesPriceBracket(txn.amount, priceBracket)) return false;
    if (merchant) {
      const haystack = `${txn.merchant || ""} ${txn.description || ""}`.toLowerCase();
      if (!haystack.includes(merchant)) return false;
    }
    return true;
  });
  const { key, dir } = state.sort;
  txns.sort((a, b) => {
    let cmp = 0;
    if (key === "date") cmp = a.date.localeCompare(b.date);
    if (key === "amount") cmp = a.amount - b.amount;
    return dir === "asc" ? cmp : -cmp;
  });

  el.transactionsTbody.innerHTML = "";
  el.noTransactions.hidden = txns.length > 0;
  el.noTransactions.textContent =
    state.periodMode === "range" ? "No transactions for this date range." : "No transactions for this month.";

  txns.forEach((txn) => {
    const tr = document.createElement("tr");
    const merchantDisplay = cleanMerchantName(txn.merchant || txn.description);

    const options = CATEGORIES.map(
      (c) => `<option value="${c}" ${c === txn.category ? "selected" : ""}>${c}</option>`
    ).join("");

    tr.innerHTML = `
      <td data-label="Date">${txn.date}</td>
      <td data-label="Merchant">${merchantDisplay}</td>
      <td data-label="Amount" class="amount">${formatCurrency(txn.amount)}</td>
      <td data-label="Category"><span class="category-cell">${categoryDot(txn.category)}<select class="category-select" data-id="${txn.id}">${options}</select></span></td>
      <td data-label=""><button type="button" class="rule-remove-btn txn-delete-btn" data-id="${txn.id}">Delete</button></td>
    `;
    el.transactionsTbody.appendChild(tr);
  });

  el.transactionsTbody.querySelectorAll(".category-select").forEach((select) => {
    select.addEventListener("change", (e) => updateCategory(e.target.dataset.id, e.target.value));
  });

  el.transactionsTbody.querySelectorAll(".txn-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => requestDelete(btn.dataset.id));
  });
}

// ---------------------------------------------------------------------------
// Deleting transactions. A plain transaction deletes immediately (with an
// Undo toast); one that's part of an averaged set of installments asks
// whether to remove just that month or the whole set.
// ---------------------------------------------------------------------------

const INSTALLMENT_RE = /^(.*) \(avg (\d+)\/(\d+)\)$/;

function installmentGroupKey(txn) {
  const m = INSTALLMENT_RE.exec(txn.description || "");
  if (!m) return null;
  return [txn.merchant, txn.source_file, m[1], m[3], txn.date.slice(0, 4)].join("|");
}

// Mirrors INSTALLMENT_AMOUNT_TOLERANCE in process_transactions.py: installments
// of one charge differ by cents at most, so a bigger gap means a different
// charge that merely shares a merchant/description.
const INSTALLMENT_AMOUNT_TOLERANCE = 0.1;

function installmentSetSize(txn, all) {
  const key = installmentGroupKey(txn);
  if (!key) return 1;
  return all.filter(
    (t) => installmentGroupKey(t) === key && Math.abs(t.amount - txn.amount) <= INSTALLMENT_AMOUNT_TOLERANCE
  ).length;
}

let pendingDeleteId = null;

function requestDelete(id) {
  const all = Object.values(state.transactionsByMonth).flat();
  const txn = all.find((t) => t.id === id);
  if (!txn) return;

  const groupSize = installmentSetSize(txn, all);
  if (groupSize <= 1) {
    deleteTransaction(id, "one");
    return;
  }

  pendingDeleteId = id;
  el.deleteModalText.textContent =
    `"${cleanMerchantName(txn.merchant || txn.description)}" is spread across ${groupSize} months. ` +
    `Delete only this month's installment, or the entire set?`;
  el.deleteGroupBtn.textContent = `Delete all ${groupSize}`;
  el.deleteOneBtn.onclick = () => {
    closeDeleteModal();
    deleteTransaction(id, "one");
  };
  el.deleteGroupBtn.onclick = () => {
    closeDeleteModal();
    deleteTransaction(id, "group");
  };
  el.deleteModal.hidden = false;
}

function closeDeleteModal() {
  el.deleteModal.hidden = true;
  pendingDeleteId = null;
}

async function deleteTransaction(id, scope) {
  try {
    const result = await postJson("/delete-transactions", { id, scope });
    await loadData();
    renderAll();
    const n = result.deleted_count;
    showToast(`Deleted ${n} transaction${n === 1 ? "" : "s"}.`, false, {
      label: "Undo",
      onClick: () => undoDelete(result.undo),
    });
  } catch (err) {
    showToast(err.message || "Failed to delete. Is server.py running?", true);
  }
}

async function undoDelete(undo) {
  try {
    await postJson("/undo-delete", undo);
    await loadData();
    renderAll();
    showToast("Deletion undone.");
  } catch (err) {
    showToast(err.message || "Failed to undo. Is server.py running?", true);
  }
}

function cleanMerchantName(name) {
  if (!name) return "";
  return name.replace(/\s*#\d+\s*$/, "").replace(/\s{2,}/g, " ").trim();
}

function formatCurrency(value) {
  const num = Number(value) || 0;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(num));
  return num < 0 ? `-${formatted}` : formatted;
}

async function updateCategory(id, newCategory) {
  try {
    const res = await fetch("/update-category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, new_category: newCategory }),
    });
    if (redirectToLoginIfUnauthorized(res)) return;
    if (!res.ok) throw new Error(await res.text());
    const result = await res.json();
    const undoAction = { label: "Undo", onClick: () => undoCategoryChange(result.undo) };

    if (result.split) {
      // The server replaced this single transaction with installments per
      // whatever averaging rule now matches - the original id no longer
      // exists, so patching local state won't do; reload everything from
      // disk instead.
      await loadData();
      renderAll();
      showToast("Category updated and spread across months per your averaging rules.", false, undoAction);
      return;
    }

    const txn = currentTransactions().find((t) => t.id === id);
    if (txn) txn.category = newCategory;

    renderOverview();
    renderTransactions();
    showToast("Category updated.", false, undoAction);
  } catch (err) {
    showToast("Failed to update category. Is server.py running?", true);
  }
}

async function undoCategoryChange(undo) {
  if (!undo) return;
  try {
    const res = await fetch("/undo-category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ undo }),
    });
    if (redirectToLoginIfUnauthorized(res)) return;
    if (!res.ok) throw new Error(await res.text());
    await loadData();
    renderAll();
    showToast("Change undone.");
  } catch (err) {
    showToast("Failed to undo. Is server.py running?", true);
  }
}

let toastTimer = null;
function showToast(message, isError = false, action = null) {
  el.toast.innerHTML = "";

  const text = document.createElement("span");
  text.textContent = message;
  el.toast.appendChild(text);

  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      clearTimeout(toastTimer);
      el.toast.hidden = true;
      action.onClick();
    });
    el.toast.appendChild(btn);
  }

  el.toast.hidden = false;
  el.toast.classList.toggle("error", isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), action ? 8000 : 3500);
}

// ---------------------------------------------------------------------------
// Upload wizard
// ---------------------------------------------------------------------------

function openUploadModal() {
  uploadState.uploadId = null;
  uploadState.pendingMapping = null;
  el.uploadModal.hidden = false;
  renderUploadFileStage();
}

function closeUploadModal() {
  el.uploadModal.hidden = true;
  el.uploadModalBody.innerHTML = "";
}

function renderUploadFileStage() {
  el.uploadModalBody.innerHTML = `
    <div class="upload-dropzone">
      <p>Choose a CSV or Excel statement to import.</p>
      <input type="file" id="upload-file-input" accept=".csv,.xlsx,.xls" />
    </div>
  `;
  document.getElementById("upload-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelected(file);
  });
}

function renderUploadLoading(message) {
  el.uploadModalBody.innerHTML = `<p class="text-muted">${message}</p>`;
}

function renderUploadError(message) {
  el.uploadModalBody.innerHTML = `
    <div class="banner">${message}</div>
    <div class="modal-actions">
      <button class="btn" id="upload-retry-btn">Try again</button>
    </div>
  `;
  document.getElementById("upload-retry-btn").addEventListener("click", renderUploadFileStage);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function handleFileSelected(file) {
  renderUploadLoading(`Reading ${file.name}...`);
  try {
    const buffer = await file.arrayBuffer();
    const contentBase64 = arrayBufferToBase64(buffer);
    const data = await postJson("/upload", { filename: file.name, content_base64: contentBase64 });
    handleUploadResponse(data);
  } catch (err) {
    renderUploadError(err.message || "Something went wrong reading that file.");
  }
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (redirectToLoginIfUnauthorized(res)) throw new Error("Redirecting to login...");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function handleUploadResponse(data) {
  if (data.status === "needs_mapping") {
    uploadState.uploadId = data.upload_id;
    renderMappingStage(data);
  } else if (data.status === "needs_categories") {
    uploadState.uploadId = data.upload_id;
    renderCategoriesStage(data);
  } else if (data.status === "done") {
    renderDoneStage(data.summary);
  }
}

function renderMappingStage(data) {
  const columnOptions = (selected) => {
    const opts = [`<option value="">-- none --</option>`];
    data.columns.forEach((col) => {
      opts.push(`<option value="${col}" ${col === selected ? "selected" : ""}>${col}</option>`);
    });
    return opts.join("");
  };

  const rows = MAPPING_FIELDS.map((field) => {
    const guess = data.guesses[field.key] || "";
    return `
      <div class="mapping-row">
        <label>${field.label}${field.required ? " *" : ""}</label>
        <select data-field="${field.key}">${columnOptions(guess)}</select>
      </div>
    `;
  }).join("");

  el.uploadModalBody.innerHTML = `
    <p>New statement format detected. Match its columns once - this is remembered for next time.</p>
    ${rows}
    <div class="mapping-row">
      <label>Venmo/Zelle?</label>
      <input type="checkbox" id="mapping-is-p2p" ${data.is_p2p_guess ? "checked" : ""} />
    </div>
    <div class="mapping-row" id="mapping-sign-row">
      <label>Amount sign</label>
      <select id="mapping-amount-sign">
        <option value="positive_is_spend">Positive = spend</option>
        <option value="negative_is_spend">Negative = spend</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="mapping-submit-btn">Continue</button>
    </div>
  `;

  document.getElementById("mapping-submit-btn").addEventListener("click", () => submitMapping(data));
}

async function submitMapping(data) {
  const mapping = {};
  MAPPING_FIELDS.forEach((field) => {
    const select = document.querySelector(`[data-field="${field.key}"]`);
    mapping[field.key] = select.value || null;
  });
  mapping.is_p2p = document.getElementById("mapping-is-p2p").checked;
  if (mapping.amount) {
    mapping.amount_sign = document.getElementById("mapping-amount-sign").value;
  }

  renderUploadLoading("Categorizing transactions...");
  try {
    const result = await postJson("/upload/mapping", { upload_id: uploadState.uploadId, mapping });
    handleUploadResponse(result);
  } catch (err) {
    renderUploadError(err.message || "Couldn't process that mapping.");
  }
}

function renderCategoriesStage(data) {
  const items = data.items
    .map(
      (item, i) => `
      <div class="ambiguous-item">
        <div class="ambiguous-item-info">
          <div class="ambiguous-item-merchant">${item.merchant || item.description}</div>
          <div class="ambiguous-item-meta">${item.date} &middot; ${formatCurrency(item.amount)}${item.is_p2p ? ` &middot; ${item.description}` : ""}</div>
        </div>
        <select data-key-index="${i}">
          <option value="">Choose...</option>
          ${data.categories.map((c) => `<option value="${c}">${c}</option>`).join("")}
        </select>
      </div>
    `
    )
    .join("");

  el.uploadModalBody.innerHTML = `
    <p>${data.items.length} merchant${data.items.length === 1 ? "" : "s"} couldn't be auto-categorized. Pick a category for each.</p>
    ${items}
    <div class="modal-actions">
      <button class="btn btn-primary" id="categories-submit-btn">Continue</button>
    </div>
  `;

  document.getElementById("categories-submit-btn").addEventListener("click", () => submitCategories(data));
}

async function submitCategories(data) {
  const selects = el.uploadModalBody.querySelectorAll("[data-key-index]");
  const categories = {};
  let missing = false;
  selects.forEach((select) => {
    const item = data.items[Number(select.dataset.keyIndex)];
    if (!select.value) {
      missing = true;
      select.style.borderColor = "var(--red)";
      return;
    }
    categories[item.key] = select.value;
  });

  if (missing) {
    showToast("Choose a category for every item.", true);
    return;
  }

  renderUploadLoading("Saving...");
  try {
    const result = await postJson("/upload/categories", { upload_id: uploadState.uploadId, categories });
    handleUploadResponse(result);
  } catch (err) {
    renderUploadError(err.message || "Couldn't save those categories.");
  }
}

function renderDoneStage(summary) {
  const monthsHtml = summary.months
    .map((m) => {
      const rows = Object.entries(m.totals)
        .map(([cat, amt]) => `<tr><td>${categoryDot(cat)}${cat}</td><td class="amount">${formatCurrency(amt)}</td></tr>`)
        .join("");
      return `
        <div class="summary-month">
          <h4>${formatMonthLabel(m.month)}${!m.has_budget ? ' <span class="text-muted">(no budget set)</span>' : ""}</h4>
          <table>${rows}<tr><td><strong>Total</strong></td><td class="amount"><strong>${formatCurrency(m.total)}</strong></td></tr></table>
        </div>
      `;
    })
    .join("");

  el.uploadModalBody.innerHTML = `
    <p>${summary.added} transaction${summary.added === 1 ? "" : "s"} added, ${summary.skipped} duplicate${summary.skipped === 1 ? "" : "s"} skipped.</p>
    ${monthsHtml}
    <div class="modal-actions">
      <button class="btn btn-primary" id="upload-done-btn">Done</button>
    </div>
  `;

  document.getElementById("upload-done-btn").addEventListener("click", async () => {
    closeUploadModal();
    await loadData();
    renderAll();
    showToast("Dashboard updated.");
  });
}

// ---------------------------------------------------------------------------
// Rules tab - category_rules.json (keyword rules) and merchant_overrides.json
// (exact merchant/note overrides). Every add/remove hits the server, which
// writes straight to those files - the categorization engine reads them
// fresh on every call, so a change here is live for the very next
// transaction processed without needing a restart.
// ---------------------------------------------------------------------------

function renderRulesView() {
  renderKeywordRules();
  renderOverrideRules();
  renderAveragingRules();
}

function renderKeywordRules() {
  const filter = state.rulesFilters.keyword;
  const rules = state.categoryRules || {};
  const totalCount = Object.values(rules).reduce((sum, kws) => sum + kws.length, 0);
  el.keywordRuleCount.textContent = `${totalCount} rule${totalCount === 1 ? "" : "s"}`;

  const groupsHtml = CATEGORIES.map((category) => {
    const keywords = (rules[category] || []).filter((kw) => {
      if (!filter) return true;
      return kw.toLowerCase().includes(filter) || category.toLowerCase().includes(filter);
    });
    if (filter && keywords.length === 0) return "";

    const chips = keywords
      .map(
        (kw) => `
        <span class="rule-chip">
          ${escapeHtml(kw)}
          <button type="button" class="rule-chip-remove" data-category="${escapeHtml(category)}" data-keyword="${escapeHtml(kw)}" aria-label="Remove rule">&times;</button>
        </span>
      `
      )
      .join("");

    return `
      <details class="rule-group" ${filter ? "open" : ""}>
        <summary>${categoryDot(category)}${category} <span class="text-muted">(${keywords.length})</span></summary>
        <div class="rule-chips">${chips || '<span class="text-muted">No keywords match.</span>'}</div>
      </details>
    `;
  }).join("");

  el.keywordRulesList.innerHTML = groupsHtml;

  el.keywordRulesList.querySelectorAll(".rule-chip-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeKeywordRule(btn.dataset.category, btn.dataset.keyword));
  });
}

function renderOverrideRules() {
  const filter = state.rulesFilters.override;
  const overrides = state.merchantOverrides || {};
  const entries = Object.entries(overrides)
    .filter(([key, category]) => {
      if (!filter) return true;
      return key.toLowerCase().includes(filter) || category.toLowerCase().includes(filter);
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

  el.overrideRuleCount.textContent = `${Object.keys(overrides).length} override${Object.keys(overrides).length === 1 ? "" : "s"}`;

  el.overrideRulesTbody.innerHTML = entries
    .map(
      ([key, category]) => `
      <tr>
        <td data-label="Merchant / Note">${escapeHtml(key)}</td>
        <td data-label="Category"><span class="category-cell">${categoryDot(category)}${category}</span></td>
        <td data-label=""><button type="button" class="rule-remove-btn" data-key="${escapeHtml(key)}">Remove</button></td>
      </tr>
    `
    )
    .join("");

  el.overrideRulesTbody.querySelectorAll(".rule-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => removeOverrideRule(btn.dataset.key));
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function submitAddKeywordRule() {
  const category = el.keywordRuleCategory.value;
  const keyword = el.keywordRuleInput.value.trim();
  if (!keyword) {
    showToast("Enter a keyword.", true);
    return;
  }

  try {
    await postJson("/rules/keyword/add", { category, keyword });
    state.categoryRules[category] = state.categoryRules[category] || [];
    state.categoryRules[category].push(keyword);
    el.keywordRuleInput.value = "";
    renderKeywordRules();
    showToast(`"${keyword}" now auto-categorizes as ${category}.`);
  } catch (err) {
    showToast(err.message || "Failed to add rule. Is server.py running?", true);
  }
}

async function removeKeywordRule(category, keyword) {
  try {
    await postJson("/rules/keyword/remove", { category, keyword });
    state.categoryRules[category] = (state.categoryRules[category] || []).filter((kw) => kw !== keyword);
    renderKeywordRules();
    showToast(`Removed "${keyword}" from ${category}.`);
  } catch (err) {
    showToast(err.message || "Failed to remove rule. Is server.py running?", true);
  }
}

async function submitAddOverrideRule() {
  const key = el.overrideRuleInput.value.trim();
  const category = el.overrideRuleCategory.value;
  if (!key) {
    showToast("Enter merchant or note text.", true);
    return;
  }

  try {
    await postJson("/rules/override/add", { key, category });
    state.merchantOverrides[key] = category;
    el.overrideRuleInput.value = "";
    renderOverrideRules();
    showToast(`"${key}" now always categorizes as ${category}.`);
  } catch (err) {
    showToast(err.message || "Failed to add override. Is server.py running?", true);
  }
}

async function removeOverrideRule(key) {
  try {
    await postJson("/rules/override/remove", { key });
    delete state.merchantOverrides[key];
    renderOverrideRules();
    showToast(`Removed override for "${key}".`);
  } catch (err) {
    showToast(err.message || "Failed to remove override. Is server.py running?", true);
  }
}

// ---------------------------------------------------------------------------
// Averaging rules (averaging_rules.json) - how a transaction's amount gets
// spread across months. Fully editable: add, remove, and adjust (in-place
// edit) any rule, including the ones the app ships with by default.
// ---------------------------------------------------------------------------

function averagingRuleFormFieldsHtml(rule) {
  const r = rule || { trigger_type: "keyword", trigger_value: "", min_amount: null, spread_type: "calendar_year", months: null };
  const isCategory = r.trigger_type === "category";
  const isInstallments = r.spread_type === "installments";
  return `
    <div class="rule-form-fields">
      <select class="ar-trigger-type">
        <option value="keyword" ${!isCategory ? "selected" : ""}>Merchant contains</option>
        <option value="category" ${isCategory ? "selected" : ""}>Category is</option>
      </select>
      <input type="text" class="ar-trigger-value-keyword" placeholder="Keyword, e.g. WALMART" value="${isCategory ? "" : escapeHtml(r.trigger_value)}" ${isCategory ? "hidden" : ""} />
      <select class="ar-trigger-value-category" ${isCategory ? "" : "hidden"}>
        ${CATEGORIES.map((c) => `<option value="${c}" ${isCategory && r.trigger_value === c ? "selected" : ""}>${c}</option>`).join("")}
      </select>
      <input type="number" class="ar-min-amount" step="0.01" min="0" placeholder="min amount (optional)" value="${r.min_amount != null ? r.min_amount : ""}" />
      <select class="ar-spread-type">
        <option value="calendar_year" ${!isInstallments ? "selected" : ""}>12 months (calendar year)</option>
        <option value="installments" ${isInstallments ? "selected" : ""}>N months (installments)</option>
      </select>
      <input type="number" class="ar-months" min="1" placeholder="months" value="${r.months || ""}" ${isInstallments ? "" : "hidden"} />
    </div>
  `;
}

function wireAveragingRuleFormToggles(container) {
  const triggerTypeSel = container.querySelector(".ar-trigger-type");
  const keywordInput = container.querySelector(".ar-trigger-value-keyword");
  const categorySelect = container.querySelector(".ar-trigger-value-category");
  triggerTypeSel.addEventListener("change", () => {
    const isCategory = triggerTypeSel.value === "category";
    keywordInput.hidden = isCategory;
    categorySelect.hidden = !isCategory;
  });

  const spreadTypeSel = container.querySelector(".ar-spread-type");
  const monthsInput = container.querySelector(".ar-months");
  spreadTypeSel.addEventListener("change", () => {
    monthsInput.hidden = spreadTypeSel.value !== "installments";
  });
}

function readAveragingRuleForm(container) {
  const triggerType = container.querySelector(".ar-trigger-type").value;
  const triggerValue =
    triggerType === "category"
      ? container.querySelector(".ar-trigger-value-category").value
      : container.querySelector(".ar-trigger-value-keyword").value.trim();
  const minAmountRaw = container.querySelector(".ar-min-amount").value;
  const spreadType = container.querySelector(".ar-spread-type").value;
  const monthsRaw = container.querySelector(".ar-months").value;
  return {
    trigger_type: triggerType,
    trigger_value: triggerValue,
    min_amount: minAmountRaw === "" ? null : parseFloat(minAmountRaw),
    spread_type: spreadType,
    months: spreadType === "installments" ? parseInt(monthsRaw, 10) : null,
  };
}

function validateAveragingRuleValues(values) {
  if (!values.trigger_value) return "Enter a trigger value.";
  if (values.spread_type === "installments" && (!values.months || values.months < 1)) {
    return "Enter a number of months (1 or more).";
  }
  return null;
}

function describeAveragingRule(rule) {
  const triggerDesc =
    rule.trigger_type === "category"
      ? `Category is <strong>${escapeHtml(rule.trigger_value)}</strong>`
      : `Merchant contains <strong>"${escapeHtml(rule.trigger_value)}"</strong>`;
  const amountDesc = rule.min_amount != null ? ` and amount &gt; ${formatCurrency(rule.min_amount)}` : "";
  const spreadDesc =
    rule.spread_type === "calendar_year"
      ? "spread evenly across 12 months (calendar year)"
      : `spread over ${rule.months} month${rule.months === 1 ? "" : "s"} (starting the transaction's month)`;
  return `${triggerDesc}${amountDesc} <span class="spread-label">&rarr; ${spreadDesc}</span>`;
}

function renderAveragingRuleAddForm() {
  el.averagingRuleForm.innerHTML = `
    ${averagingRuleFormFieldsHtml(null)}
    <div class="rule-form-actions">
      <button class="btn btn-primary" id="averaging-rule-add-btn">Add rule</button>
    </div>
  `;
  wireAveragingRuleFormToggles(el.averagingRuleForm);
  document.getElementById("averaging-rule-add-btn").addEventListener("click", submitAddAveragingRule);
}

function renderAveragingRules() {
  const rules = state.averagingRules || [];
  el.averagingRuleCount.textContent = `${rules.length} rule${rules.length === 1 ? "" : "s"}`;

  renderAveragingRuleAddForm();

  el.averagingRulesList.innerHTML = rules
    .map((rule) => {
      if (rule.id === state.editingAveragingRuleId) {
        return `
          <div class="averaging-rule-row editing" data-id="${rule.id}">
            ${averagingRuleFormFieldsHtml(rule)}
            <div class="rule-form-actions">
              <button class="btn btn-primary averaging-rule-save-btn" data-id="${rule.id}">Save</button>
              <button class="btn btn-ghost averaging-rule-cancel-btn">Cancel</button>
            </div>
          </div>
        `;
      }
      return `
        <div class="averaging-rule-row" data-id="${rule.id}">
          <div class="averaging-rule-text">${describeAveragingRule(rule)}</div>
          <div class="averaging-rule-actions">
            <button class="btn btn-ghost averaging-rule-edit-btn" data-id="${rule.id}">Edit</button>
            <button class="rule-remove-btn averaging-rule-remove-btn" data-id="${rule.id}">Remove</button>
          </div>
        </div>
      `;
    })
    .join("");

  el.averagingRulesList.querySelectorAll(".averaging-rule-row.editing").forEach((row) => wireAveragingRuleFormToggles(row));

  el.averagingRulesList.querySelectorAll(".averaging-rule-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editingAveragingRuleId = btn.dataset.id;
      renderAveragingRules();
    });
  });

  el.averagingRulesList.querySelectorAll(".averaging-rule-cancel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editingAveragingRuleId = null;
      renderAveragingRules();
    });
  });

  el.averagingRulesList.querySelectorAll(".averaging-rule-save-btn").forEach((btn) => {
    btn.addEventListener("click", () => submitUpdateAveragingRule(btn.dataset.id));
  });

  el.averagingRulesList.querySelectorAll(".averaging-rule-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => removeAveragingRule(btn.dataset.id));
  });
}

async function submitAddAveragingRule() {
  const values = readAveragingRuleForm(el.averagingRuleForm);
  const error = validateAveragingRuleValues(values);
  if (error) {
    showToast(error, true);
    return;
  }

  try {
    const result = await postJson("/rules/averaging/add", values);
    state.averagingRules = result.averaging_rules;
    renderAveragingRules();
    showToast("Averaging rule added.");
  } catch (err) {
    showToast(err.message || "Failed to add rule. Is server.py running?", true);
  }
}

async function submitUpdateAveragingRule(id) {
  const row = el.averagingRulesList.querySelector(`.averaging-rule-row.editing[data-id="${id}"]`);
  const values = readAveragingRuleForm(row);
  const error = validateAveragingRuleValues(values);
  if (error) {
    showToast(error, true);
    return;
  }

  try {
    const result = await postJson("/rules/averaging/update", { id, ...values });
    state.averagingRules = result.averaging_rules;
    state.editingAveragingRuleId = null;
    renderAveragingRules();
    showToast("Averaging rule updated.");
  } catch (err) {
    showToast(err.message || "Failed to update rule. Is server.py running?", true);
  }
}

async function removeAveragingRule(id) {
  try {
    const result = await postJson("/rules/averaging/remove", { id });
    state.averagingRules = result.averaging_rules;
    renderAveragingRules();
    showToast("Averaging rule removed.");
  } catch (err) {
    showToast(err.message || "Failed to remove rule. Is server.py running?", true);
  }
}

init();
