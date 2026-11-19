// "מחיקת לקוח": shows exactly what will be deleted (here and in Morning) before the owner confirms.
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { fmtNum } from '../../constants.js';
import { Modal, ErrorNote, Notice, Spinner } from '../../components/ui.jsx';

const CARD_TEXT = {
  delete: 'כרטיס הלקוח יימחק גם ב-Morning.',
  has_documents: 'כרטיס הלקוח ב-Morning יישאר, כי יש עליו מסמכים (Morning לא מוחקת כרטיס עם מסמכים).',
  already_removed: 'כרטיס הלקוח כבר לא קיים ב-Morning.',
};

/** @param {{ customerId: number|null, onClose: () => void, onDeleted: (result: object) => void }} props */
export default function DeleteCustomerDialog({ customerId, onClose, onDeleted }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPlan(null);
    setError(null);
    if (customerId) api.get(`/accounting/customers/${customerId}/delete-plan`).then(setPlan).catch((e) => setError(e.message));
  }, [customerId]);

  const close = () => { if (!busy) onClose(); };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onDeleted(await api.del(`/accounting/customers/${customerId}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!customerId} onClose={close} title="מחיקת לקוח">
      {!plan ? (
        error ? <ErrorNote error={error} /> : <div className="grid h-24 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>
      ) : (
        <div className="space-y-3 text-sm text-charcoal-700">
          <p><span className="font-semibold" dir="auto">{plan.customer.name || 'ללא שם'}</span> יימחק מהמערכת.</p>
          <ul className="list-disc space-y-1.5 pr-5">
            {plan.documents > 0 && (
              <li>
                יימחקו מהמערכת גם {fmtNum(plan.documents)} מסמכים שלו, והסכומים שלהם ירדו מהדשבורד.
                ב-Morning המסמכים נשארים: קבלה היא מסמך חשבונאי ואי אפשר למחוק אותה.
              </li>
            )}
            {plan.cards.length
              ? plan.cards.map((c) => <li key={`${c.connectionId}-${c.externalId}`}>{CARD_TEXT[c.morning]}</li>)
              : <li>ללקוח אין כרטיס ב-Morning, לכן שם לא ישתנה דבר.</li>}
            <li>הסנכרון הבא לא יחזיר את הלקוח ואת המסמכים שלו.</li>
          </ul>
          <Notice>אי אפשר לבטל את המחיקה.</Notice>
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-secondary" onClick={close} disabled={busy}>ביטול</button>
            <button className="btn-danger" onClick={confirm} disabled={busy}>
              {busy ? <Spinner /> : <Trash2 className="h-4 w-4" />} מחיקה לצמיתות
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
