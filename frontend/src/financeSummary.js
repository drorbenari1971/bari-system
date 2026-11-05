// Finance calculations and formatting. Amounts are integer agorot, so sums stay exact.
// Kept in the UI so the local app and the GitHub Pages demo calculate the same way.

const moneyFormat = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2, minimumFractionDigits: 0 });
export const fmtMoney = (agorot) => moneyFormat.format(agorot / 100);

const compactFormat = new Intl.NumberFormat('he-IL', { notation: 'compact', maximumFractionDigits: 1 });
export const fmtMoneyCompact = (agorot) => `₪${compactFormat.format(agorot / 100)}`;

export const fmtMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('he-IL', { month: 'short', year: '2-digit' });
};

export const fmtDay = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
};

const pad = (n) => String(n).padStart(2, '0');
export const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// "1,234.50" -> 123450. Returns null when the text is not a positive amount with up to 2 decimals.
export function parseAmount(text) {
  const clean = String(text ?? '').replace(/[₪,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  const agorot = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return agorot > 0 && Number.isSafeInteger(agorot) ? agorot : null;
}
export const amountToInput = (agorot) => (agorot % 100 === 0 ? String(agorot / 100) : (agorot / 100).toFixed(2));

function monthsBetween(first, last) {
  const months = [];
  let [y, m] = first.split('-').map(Number);
  const [endY, endM] = last.split('-').map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${pad(m)}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

function breakdown(rows) {
  const total = rows.reduce((s, r) => s + r.amount_agorot, 0);
  const byCategory = new Map();
  for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.amount_agorot);
  return [...byCategory.entries()]
    .map(([category, amount]) => ({ category, amount, share: total ? amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

// rows: transactions already limited to the period. from/to ('YYYY-MM-DD' or null) set which months
// are shown, so a month with no entries still appears in the cash flow.
export function summarize(rows, from = null, to = null) {
  const incomeRows = rows.filter((r) => r.kind === 'income');
  const expenseRows = rows.filter((r) => r.kind === 'expense');
  const sum = (list) => list.reduce((s, r) => s + r.amount_agorot, 0);
  const income = sum(incomeRows);
  const expenses = sum(expenseRows);
  const net = income - expenses;

  const dates = rows.map((r) => r.date).sort();
  const first = from?.slice(0, 7) ?? dates[0]?.slice(0, 7);
  const last = to?.slice(0, 7) ?? dates[dates.length - 1]?.slice(0, 7);
  let cumulative = 0;
  const months = first && last ? monthsBetween(first, last).map((month) => {
    const inMonth = rows.filter((r) => r.date.startsWith(month));
    const monthIncome = sum(inMonth.filter((r) => r.kind === 'income'));
    const monthExpenses = sum(inMonth.filter((r) => r.kind === 'expense'));
    cumulative += monthIncome - monthExpenses;
    return { month, income: monthIncome, expenses: monthExpenses, net: monthIncome - monthExpenses, cumulative };
  }) : [];

  return {
    income,
    expenses,
    net,
    margin: income > 0 ? net / income : null, // null: no income, so profitability is undefined
    months,
    byIncome: breakdown(incomeRows),
    byExpense: breakdown(expenseRows),
  };
}
