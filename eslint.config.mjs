// ESLint for the whole repo: `npm run lint`.
// Errors are rules of this project (see AGENTS.md) or likely bugs. They fail the CI.
// Warnings are signals that we watch, such as complexity. They do not fail the CI.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      'docs/.vitepress/cache/**',
      'docs/.vitepress/dist/**',
      '.claude/**',
      'plans/**',
      'apps/server/native/**',
      'tools/pi-image/.work/**',
      'tools/pi-image/deploy/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Signals, not gates (see docs/develop/index.md#lint)
      complexity: ['warn', 12],
      'max-depth': ['warn', 4],
      // An interface that only extends one type is a name for that type (for example HaasMachineData)
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      // An unused name with a leading _ is on purpose
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // The web app runs in the browser
    files: ['apps/web/**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Text with the primary color uses text-primary-text, so it is easy to read in light mode (AGENTS.md)
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/(^|[\\s:])text-primary(\\/|\\s|$)/], TemplateElement[value.raw=/(^|[\\s:])text-primary(\\/|\\s|$)/]',
          message: 'Use text-primary-text for text. The primary color is for fills and borders (AGENTS.md).',
        },
      ],
    },
  },
  {
    // The server logs with createLogger (apps/server/src/logging/logger.ts), not with console (AGENTS.md)
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/**/*.test.ts', 'apps/server/src/logging/**', 'apps/server/src/resetPassword.ts'],
    rules: {
      'no-console': 'error',
    },
  },
);
