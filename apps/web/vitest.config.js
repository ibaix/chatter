import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// A test that checks a shown time gets the same text on each computer: the time zone UTC and the format of en-US.
// The test processes start after this, so they get these settings.
process.env.TZ = 'UTC';
process.env.LC_ALL = 'en_US.UTF-8';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    server: {
      deps: {
        // Node cannot load the Toolpath UI package by itself (its table library imports folders),
        // so Vite builds it for the tests, as it does for the app
        inline: [/@toolpath\/ui/, /@table-library/],
      },
    },
  },
});
