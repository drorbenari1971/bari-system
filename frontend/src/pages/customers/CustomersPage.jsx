// "ניהול לקוחות": tabs for the customers module. The open tab and customer card are kept in the
// address (?tab=...&customer=...), so the browser's back button and refresh work as expected.
import { useSearchParams } from 'react-router-dom';
import CustomersList from './CustomersList.jsx';
import CustomerCard from './CustomerCard.jsx';
import SyncSettings from './SyncSettings.jsx';

const TABS = [
  { id: 'customers', label: 'לקוחות' },
  { id: 'settings', label: 'סנכרון והגדרות' },
];

export default function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : TABS[0].id;
  const customerId = Number(params.get('customer')) || null;
  const go = (next) => setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">ניהול לקוחות</h1>
          <p className="page-sub">לקוחות, קבלות וחשבוניות ממערכת הנהלת החשבונות</p>
        </div>
        <div className="flex rounded-xl border border-charcoal-200 bg-surface p-0.5 text-sm">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => go({ tab: t.id === TABS[0].id ? null : t.id })} className={`rounded-lg px-3 py-1.5 ${tab === t.id ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{t.label}</button>
          ))}
        </div>
      </div>
      {tab === 'settings' && <SyncSettings />}
      {tab === 'customers' && (customerId
        ? <CustomerCard id={customerId} onBack={() => go({})} />
        : <CustomersList onOpen={(id) => go({ customer: String(id) })} />)}
    </div>
  );
}
