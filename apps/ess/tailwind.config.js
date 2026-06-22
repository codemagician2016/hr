/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // White-label surface: every branded element reads the tenant's
      // resolved CSS variables (injected on <html> by TenantProvider).
      colors: {
        brand: {
          DEFAULT: 'var(--theme-primary)',
          dark: 'var(--theme-primary-dark)',
          accent: 'var(--theme-accent)',
          fg: 'var(--theme-on-primary)',
        },
        // DriftHR product brand (app chrome / fallbacks; distinct from the
        // per-tenant white-label palette resolved at runtime).
        drifthr: {
          teal: '#16B6A6',
          blue: '#3B6FE3',
          ink: '#16243B',
          mist: '#EAF1F4',
        },
      },
      fontFamily: {
        sans: ['var(--font-manrope)', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      keyframes: {
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '15%': { transform: 'translateX(-5px)' },
          '45%': { transform: 'translateX(5px)' },
          '75%': { transform: 'translateX(-3px)' },
        },
      },
      animation: {
        shake: 'shake 0.35s ease-in-out',
      },
    },
  },
  plugins: [],
};
