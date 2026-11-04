import { useEffect } from 'react';
import { Loader2, X } from 'lucide-react';
import { STATUS } from '../constants.js';

export const Spinner = ({ className = 'h-4 w-4' }) => <Loader2 className={`${className} animate-spin`} />;

export function StatusBadge({ status }) {
  const s = STATUS[status] ?? STATUS.draft;
  return <span className={`chip ${s.cls}`}>{s.label}</span>;
}

export function PlatformBadge({ platform }) {
  return platform === 'instagram'
    ? <span className="chip bg-gradient-to-l from-fuchsia-100 to-amber-100 text-fuchsia-800">אינסטגרם</span>
    : <span className="chip bg-blue-50 text-blue-700">פייסבוק</span>;
}

export function DemoBadge({ show = true, children = 'דמו' }) {
  if (!show) return null;
  return <span className="chip bg-honey/15 text-amber-800 border border-honey/30">{children}</span>;
}

export function StatCard({ icon: Icon, label, value, sub, tone = 'sage' }) {
  const tones = {
    sage: 'bg-sage-50 text-sage-700',
    honey: 'bg-amber-50 text-amber-700',
    charcoal: 'bg-charcoal-50 text-charcoal-700',
    sky: 'bg-sky-50 text-sky-700',
  };
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-charcoal-500">{label}</span>
        {Icon && <span className={`rounded-xl p-2 ${tones[tone]}`}><Icon className="h-4 w-4" /></span>}
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight text-charcoal-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-charcoal-400">{sub}</div>}
    </div>
  );
}

export function Card({ title, action, children, className = '', bodyClass = 'p-5' }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-charcoal-100 px-5 py-3.5">
          <h2 className="font-semibold text-charcoal-800">{title}</h2>
          {action}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {Icon && <Icon className="mb-3 h-8 w-8 text-sage-300" />}
      <div className="font-medium text-charcoal-700">{title}</div>
      {children && <div className="mt-1 text-sm text-charcoal-400">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide = false }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm md:p-10" onMouseDown={onClose}>
      <div className={`card w-full ${wide ? 'max-w-5xl' : 'max-w-lg'}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-charcoal-100 px-5 py-3.5">
          <h3 className="font-semibold">{title}</h3>
          <button className="btn-ghost p-1.5" onClick={onClose} aria-label="סגור"><X className="h-4 w-4" /></button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
}

export function Notice({ children }) {
  return <div className="rounded-xl border border-honey/30 bg-amber-50/70 px-3 py-2 text-sm text-amber-900">{children}</div>;
}
