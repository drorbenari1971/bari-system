/** @type {import('tailwindcss').Config} */

// Brand colors are CSS variables (defined in src/index.css) so the whole palette
// switches between light and dark mode when <html> gets the `dark` class.
const scale = (name) =>
  Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]));

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sage: scale('sage'),
        charcoal: { DEFAULT: 'rgb(var(--charcoal-900) / <alpha-value>)', ...scale('charcoal') },
        cream: 'rgb(var(--cream) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        honey: '#d9a441',
      },
      fontFamily: { sans: ['Heebo', 'system-ui', 'sans-serif'] },
      boxShadow: { soft: '0 1px 2px rgba(43,47,44,.04), 0 4px 16px rgba(43,47,44,.06)' },
    },
  },
  plugins: [],
};
