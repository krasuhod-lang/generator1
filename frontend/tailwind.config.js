/** @type {import('tailwindcss').Config} */
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
        },
        // Status / trend tokens из ТЗ §6.1 — модули отчёта (Striking Distance,
        // CTR Gap, Content Health) подсвечивают точки роста этими цветами.
        'status-critical': '#EF4444', // red-500
        'status-warning':  '#F59E0B', // amber-500
        'status-healthy':  '#10B981', // emerald-500
        'trend-up':        '#10B981',
        'trend-down':      '#EF4444',
        'brand-primary':   '#6366F1', // indigo-500
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
