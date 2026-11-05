import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Sparkles, CalendarDays, BarChart3, MessageCircle, ListChecks, Leaf, Trash2, Moon, Sun, Wallet } from 'lucide-react';
import { useStatus, useTheme } from '../App.jsx';
import { api } from '../api.js';

const NAV = [
  { to: '/', label: 'דשבורד', icon: LayoutDashboard },
  { to: '/generator', label: 'מחולל תוכן', icon: Sparkles },
  { to: '/calendar', label: 'לוח תוכן ותזמון', icon: CalendarDays },
  { to: '/analytics', label: 'אנליטיקס ותובנות', icon: BarChart3 },
  { to: '/engagement', label: 'תגובות ומעורבות', icon: MessageCircle },
  { to: '/tasks', label: 'ניהול משימות', icon: ListChecks },
  { to: '/finance', label: 'כספים ותזרים', icon: Wallet },
];

// Palettes per mode (see index.css); id '' is the default. Swatch = background / accent.
const PALETTES = {
  light: [
    { id: '', label: 'ירוק יער', bg: '#f3f6f2', accent: '#166b36' },
    { id: 'sage', label: 'מרווה', bg: '#fafaf7', accent: '#436c48' },
    { id: 'terracotta', label: 'טרקוטה', bg: '#faf5ee', accent: '#b04422' },
    { id: 'ocean', label: 'טורקיז', bg: '#f2f6f8', accent: '#0c6e78' },
  ],
  dark: [
    { id: '', label: 'יער לילי', bg: '#0c110e', accent: '#168040' },
    { id: 'sage', label: 'מרווה', bg: '#141815', accent: '#4c8052' },
    { id: 'graphite', label: 'גרפיט', bg: '#101113', accent: '#168040' },
    { id: 'deep', label: 'ירוק עמוק', bg: '#091a13', accent: '#188644' },
  ],
};

function PalettePicker() {
  const { dark, palettes, setPalette } = useTheme();
  const mode = dark ? 'dark' : 'light';
  const current = palettes[mode];
  return (
    <div className="border-t border-charcoal-100 px-5 py-3">
      <div className="mb-2 text-xs font-medium text-charcoal-700">{dark ? 'פלטת צבעים כהה' : 'פלטת צבעים'}</div>
      <div className="flex gap-2">
        {PALETTES[mode].map((p) => (
          <button
            key={p.id || 'default'}
            onClick={() => setPalette(mode, p.id)}
            title={p.label}
            aria-label={p.label}
            className={`h-7 w-7 rounded-full border-2 transition ${current === p.id ? 'border-charcoal-900 scale-110' : 'border-charcoal-200'}`}
            style={{ background: `linear-gradient(135deg, ${p.bg} 50%, ${p.accent} 50%)` }}
          />
        ))}
      </div>
      <div className="mt-1.5 text-[11px] text-charcoal-500">{PALETTES[mode].find((p) => p.id === current)?.label}</div>
    </div>
  );
}

function Dot({ on, label, offLabel = 'דמו' }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-charcoal-500">{label}</span>
      <span className={`flex items-center gap-1.5 ${on ? 'text-sage-700' : 'text-amber-700'}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-sage-500' : 'bg-honey'}`} />
        {on ? 'מחובר' : offLabel}
      </span>
    </div>
  );
}

export default function Sidebar() {
  const { status, refreshStatus } = useStatus();
  const { dark, toggleTheme } = useTheme();

  const clearDemo = async () => {
    if (!confirm('למחוק את כל נתוני הדמו (פוסטים, תגובות, משימות ותובנות לדוגמה)?')) return;
    await api.post('/demo/clear');
    await refreshStatus();
    window.location.reload();
  };

  const linkCls = ({ isActive }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition whitespace-nowrap ${
      isActive ? 'bg-sage-600 text-white shadow-soft' : 'text-charcoal-600 hover:bg-sage-50 hover:text-sage-800'
    }`;

  return (
    <aside className="sticky top-0 z-30 border-b border-charcoal-100 bg-surface md:h-screen md:w-64 md:shrink-0 md:border-b-0 md:border-l">
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2.5 px-5 py-4 md:py-6">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-sage-600 text-white"><Leaf className="h-5 w-5" /></span>
          <div>
            <div className="text-xl font-bold leading-none text-charcoal-900">בריא</div>
            <div className="mt-1 text-[11px] text-charcoal-400">מערכת שיווק ואוטומציה</div>
          </div>
          <button
            onClick={toggleTheme}
            className="mr-auto grid h-9 w-9 place-items-center rounded-xl border border-charcoal-200 text-charcoal-600 transition hover:bg-sage-50 hover:text-sage-800"
            title={dark ? 'מעבר למצב בהיר' : 'מעבר למצב כהה'}
            aria-label={dark ? 'מעבר למצב בהיר' : 'מעבר למצב כהה'}
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>

        <nav className="scrollbar-thin flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:overflow-visible md:pb-0">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className={linkCls}>
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <PalettePicker />

        <div className="hidden space-y-2 border-t border-charcoal-100 px-5 py-4 md:block">
          <div className="mb-1 text-xs font-medium text-charcoal-700">חיבורים</div>
          {status ? (
            <>
              <Dot on={status.claude} label="Claude" />
              <Dot on={status.images} label="יצירת תמונות" />
              <Dot on={status.facebook} label="פייסבוק" offLabel="סימולציה" />
              <Dot on={status.instagram && status.imageHosting} label="אינסטגרם" offLabel="סימולציה" />
            </>
          ) : (
            <div className="text-xs text-red-600">השרת לא זמין</div>
          )}
          {status?.hasDemoData && (
            <button onClick={clearDemo} className="mt-2 flex items-center gap-1.5 text-xs text-charcoal-400 hover:text-red-600">
              <Trash2 className="h-3 w-3" /> נקה נתוני דמו
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
