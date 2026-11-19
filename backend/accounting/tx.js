// Transactions for the module. Nested calls become savepoints, so a step inside a larger unit
// (one customer inside a page) can fail and roll back alone. fn must be synchronous.
import { db } from '../db.js';

let depth = 0;

export function tx(fn) {
  const savepoint = `acc_sp_${depth}`;
  db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN');
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (err) {
    depth--;
    db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    throw err;
  }
}
