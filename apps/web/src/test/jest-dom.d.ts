// Gives the jest-dom matchers (toBeInTheDocument, toHaveAttribute, ...) to the Vitest types.
// jest-dom's own '@testing-library/jest-dom/vitest' types declare `Assertion<T>`,
// but Vitest 5 declares `Assertion<R, T>`, so TypeScript does not merge them.
// Remove this file when jest-dom ships types for Vitest 5.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<R, T> extends TestingLibraryMatchers<unknown, R> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
