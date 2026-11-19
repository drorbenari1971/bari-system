import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { providerIncome } from '../accounting/financeIncome.js';

const router = Router();
const MAX_AMOUNT_AGOROT = 100_000_000_000; // 1 billion NIS: catches typos
const MAX_TEXT = 60;

const isRealDate = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) return false;
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
};

// Returns clean fields, or { error } with a message for the user.
function parseTransaction(body) {
  const { kind, date, category, subcategory = '', amount_agorot: amount } = body;
  if (!['income', 'expense'].includes(kind)) return { error: 'יש לבחור הכנסה או הוצאה' };
  if (!isRealDate(date)) return { error: 'תאריך לא תקין' };
  const cat = String(category ?? '').trim();
  const sub = kind === 'expense' ? String(subcategory ?? '').trim() : '';
  if (!cat) return { error: kind === 'income' ? 'יש לבחור מוצר או סיווג' : 'יש לבחור סוג הוצאה' };
  if (cat.length > MAX_TEXT || sub.length > MAX_TEXT) return { error: `עד ${MAX_TEXT} תווים בכל שדה` };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { error: 'הסכום חייב להיות גדול מאפס' };
  if (amount > MAX_AMOUNT_AGOROT) return { error: 'הסכום גדול מדי, בדקו שאין טעות הקלדה' };
  return { kind, date, category: cat, subcategory: sub, amount_agorot: amount };
}

const hydrate = (row) => ({ ...row, source: 'manual', is_demo: !!row.is_demo });
const getRow = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

router.get('/transactions', (req, res) => {
  const { from, to, kind } = req.query;
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const args = [];
  if (from) { sql += ' AND date >= ?'; args.push(String(from)); }
  if (to) { sql += ' AND date <= ?'; args.push(String(to)); }
  if (kind) { sql += ' AND kind = ?'; args.push(String(kind)); }
  sql += ' ORDER BY date DESC, id DESC';
  const manual = db.prepare(sql).all(...args).map(hydrate);
  // Income from Morning is read from the synced receipts (read-only here), never copied.
  const morning = kind === 'expense' ? [] : providerIncome({ from: from ? String(from) : null, to: to ? String(to) : null });
  res.json([...manual, ...morning].sort((a, b) => b.date.localeCompare(a.date)));
});

router.post('/transactions', (req, res) => {
  const t = parseTransaction(req.body);
  if (t.error) return res.status(400).json({ error: t.error });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO transactions (kind, date, category, subcategory, amount_agorot) VALUES (?, ?, ?, ?, ?)',
  ).run(t.kind, t.date, t.category, t.subcategory, t.amount_agorot);
  res.json(hydrate(getRow(lastInsertRowid)));
});

router.put('/transactions/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'הרשומה לא נמצאה' });
  const t = parseTransaction({ ...row, ...req.body });
  if (t.error) return res.status(400).json({ error: t.error });
  db.prepare('UPDATE transactions SET kind = ?, date = ?, category = ?, subcategory = ?, amount_agorot = ?, updated_at = ? WHERE id = ?')
    .run(t.kind, t.date, t.category, t.subcategory, t.amount_agorot, nowIso(), row.id);
  res.json(hydrate(getRow(row.id)));
});

router.delete('/transactions/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Types the owner added, plus types already used in entries (typed before this list existed).
const listTypes = (kind) => [...new Set([
  ...db.prepare('SELECT name FROM finance_types WHERE kind = ? ORDER BY id').all(kind).map((r) => r.name),
  ...db.prepare('SELECT DISTINCT category FROM transactions WHERE kind = ? ORDER BY category').all(kind).map((r) => r.category),
])];

router.get('/types', (req, res) => {
  const kind = String(req.query.kind ?? '');
  if (!['income', 'expense'].includes(kind)) return res.status(400).json({ error: 'סוג לא תקין' });
  res.json(listTypes(kind));
});

router.post('/types', (req, res) => {
  const { kind } = req.body;
  const name = String(req.body.name ?? '').trim().replace(/\s+/g, ' ');
  if (!['income', 'expense'].includes(kind)) return res.status(400).json({ error: 'סוג לא תקין' });
  if (!name) return res.status(400).json({ error: 'יש להקליד שם' });
  if (name.length > MAX_TEXT) return res.status(400).json({ error: `עד ${MAX_TEXT} תווים` });
  db.prepare('INSERT OR IGNORE INTO finance_types (kind, name) VALUES (?, ?)').run(kind, name);
  res.json({ name, types: listTypes(kind) });
});

// Removes only the sample rows, so real entries are not mixed with them in the totals.
router.delete('/demo', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE is_demo = 1').run();
  res.json({ ok: true });
});

export default router;
