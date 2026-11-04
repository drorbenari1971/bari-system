import { Router } from 'express';
import { db, nowIso } from '../db.js';

const router = Router();
const STATUSES = ['todo', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

router.get('/', (req, res) => {
  res.json(db.prepare(`
    SELECT * FROM tasks
    ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
             CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             COALESCE(due_date, '9999') ASC, id DESC
  `).all());
});

router.post('/', (req, res) => {
  const { title, description = '', priority = 'medium', due_date = null, status = 'todo' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'נדרשת כותרת למשימה' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO tasks (title, description, status, priority, due_date) VALUES (?, ?, ?, ?, ?)',
  ).run(title.trim(), description, STATUSES.includes(status) ? status : 'todo',
    PRIORITIES.includes(priority) ? priority : 'medium', due_date || null);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'משימה לא נמצאה' });
  const next = { ...task, ...req.body };
  if (!STATUSES.includes(next.status) || !PRIORITIES.includes(next.priority)) return res.status(400).json({ error: 'ערך לא חוקי' });
  db.prepare('UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, due_date = ?, updated_at = ? WHERE id = ?')
    .run(next.title, next.description, next.status, next.priority, next.due_date || null, nowIso(), task.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
