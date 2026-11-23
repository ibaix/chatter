import { describe, it, expect } from 'vitest';
import { sizeText } from './sizeText.js';

describe('sizeText', () => {
  it('gives a whole number of MB in MB', () => {
    expect(sizeText(64 * 1024 * 1024)).toBe('64 MB');
  });

  it('gives a whole number of KB in KB', () => {
    expect(sizeText(64 * 1024)).toBe('64 KB');
  });

  it('gives the number of bytes for another size', () => {
    expect(sizeText(500)).toBe('500 bytes');
    expect(sizeText(1024 * 1024 + 1)).toBe('1048577 bytes');
  });
});
