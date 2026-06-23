/** @type {import('tailwindcss').Config} */
//
// PR-3: Premium UI Foundation & Design Tokens.
// Расширяем существующие токены (brand + status), добавляем явный slate-фон
// (фоновая поверхность дашборда из ТЗ §6.2) и алиасы для статусов роста/
// падения KPI. tabular-nums включаются через утилиту Tailwind tabular-nums
// и подкреплены в `style.css` (`.kpi-figure`) на уровне font-feature-settings,
// чтобы цифры KPI выравнивались по разрядам при анимации.
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#6366f1', // indigo-500
          dark:    '#4f46e5', // indigo-600
          light:   '#a5b4fc', // indigo-300
          indigo:  '#6366f1', // brand-indigo — акцентный цвет premium UI
        },
        // Status / trend tokens из ТЗ §6.1 — модули отчёта (Striking Distance,
        // CTR Gap, Content Health) подсвечивают точки роста этими цветами.
        // Семантические алиасы для PR-3..6 (рост/внимание/критика).
        'status-critical': '#EF4444', // red-500
        'status-warning':  '#F59E0B', // amber-500
        'status-healthy':  '#10B981', // emerald-500
        'status-growth':   '#10B981', // emerald-500 (рост KPI)
        'status-attention':'#F59E0B', // amber-500 (внимание)
        'status-danger':   '#EF4444', // red-500   (критично)
        'trend-up':        '#10B981',
        'trend-down':      '#EF4444',
        'brand-primary':   '#6366F1', // indigo-500
        // Premium dashboard surface (ТЗ §6.2): глубокий slate-фон для тёмной
        // темы, поверх которого ложатся карточки KPI и таймлайн работ.
        surface: {
          base:   '#0f172a', // slate-900 — фон страницы
          raised: '#1e293b', // slate-800 — фон карточек
          muted:  '#334155', // slate-700 — borders/dividers
        },
        // Чуть более светлая и приятная сине-серая палитра.
        // Переопределяет стандартный `gray`, который используется по всему
        // приложению, поэтому весь интерфейс становится мягче и светлее,
        // а надписи — читабельнее, без правок в каждом компоненте.
        gray: {
          50:  '#f6f8fb',
          100: '#eaeef6',
          200: '#d3dae8',
          300: '#aab5cb',
          400: '#8995af',
          500: '#697391',
          600: '#515b78',
          700: '#3b4663',
          800: '#28324d',
          900: '#1c2438',
          950: '#141b2c',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
