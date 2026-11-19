// "ניהול לקוחות": tabs for the customers module. Each tab is its own component.
import { useState } from 'react';
import SyncSettings from './SyncSettings.jsx';

const TABS = [
  { id: 'settings', label: 'סנכרון והגדרות', component: SyncSettings },
];

export default function CustomersPage() {
  const [tab, setTab] = useState(TABS[0].id);
  const Active = TABS.find((t) => t.id === tab).component;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">ניהול לקוחות</h1>
          <p className="page-sub">לקוחות, חשבוניות וקבלות ממערכת הנהלת החשבונות</p>
        </div>
        {TABS.length > 1 && (
          <div className="flex rounded-xl border border-charcoal-200 bg-surface p-0.5 text-sm">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`rounded-lg px-3 py-1.5 ${tab === t.id ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{t.label}</button>
            ))}
          </div>
        )}
      </div>
      <Active />
    </div>
  );
}
