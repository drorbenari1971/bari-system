import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ContentGenerator from './pages/ContentGenerator.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import Analytics from './pages/Analytics.jsx';
import Engagement from './pages/Engagement.jsx';
import Tasks from './pages/Tasks.jsx';
import Finance from './pages/Finance.jsx';
import { api, STATIC_DEMO } from './api.js';

const StatusContext = createContext({ status: null, refreshStatus: () => {} });
export const useStatus = () => useContext(StatusContext);

const ThemeContext = createContext({ dark: false, toggleTheme: () => {}, palettes: {}, setPalette: () => {} });
export const useTheme = () => useContext(ThemeContext);

export default function App() {
  const [status, setStatus] = useState(null);
  const refreshStatus = useCallback(() => api.get('/status').then(setStatus).catch(() => setStatus(null)), []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // Initial class/attributes are set by the inline script in index.html (no flash on load).
  // The DOM is updated before the state change so children (charts) read the new CSS variables.
  const root = document.documentElement;
  const [dark, setDark] = useState(() => root.classList.contains('dark'));
  const toggleTheme = useCallback(() => {
    const next = !root.classList.contains('dark');
    root.classList.toggle('dark', next);
    try { localStorage.setItem('bari-theme', next ? 'dark' : 'light'); } catch { /* storage unavailable */ }
    setDark(next);
  }, [root]);

  // Palette per mode ('' = the default in :root / .dark): stored as <html data-light|data-dark>.
  const [palettes, setPalettes] = useState(() => ({ light: root.dataset.light || '', dark: root.dataset.dark || '' }));
  const setPalette = useCallback((mode, id) => {
    if (id) root.dataset[mode] = id;
    else delete root.dataset[mode];
    try { localStorage.setItem(`bari-palette-${mode}`, id); } catch { /* storage unavailable */ }
    setPalettes((p) => ({ ...p, [mode]: id }));
  }, [root]);

  return (
    <ThemeContext.Provider value={{ dark, toggleTheme, palettes, setPalette }}>
    <StatusContext.Provider value={{ status, refreshStatus }}>
      <div className="flex min-h-screen flex-col md:flex-row">
        <Sidebar />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto max-w-7xl">
            {STATIC_DEMO && (
              <div className="mb-5 rounded-xl border border-honey/30 bg-amber-50/70 px-3 py-2 text-sm text-amber-900">
                גרסת הדגמה: כל הנתונים לדוגמה ונשמרים רק בדפדפן שלך. שום דבר לא מתפרסם בפייסבוק או באינסטגרם.
              </div>
            )}
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/generator" element={<ContentGenerator />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/engagement" element={<Engagement />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/finance" element={<Finance />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </StatusContext.Provider>
    </ThemeContext.Provider>
  );
}
