const BYTES_IN_KB = 1024;
const BYTES_IN_MB = 1024 * 1024;

/** "16 MB", "64 KB", or the number of bytes when the size is not a whole number of KB */
export function sizeText(bytes: number): string {
  if (bytes >= BYTES_IN_MB && bytes % BYTES_IN_MB === 0) return `${bytes / BYTES_IN_MB} MB`;
  if (bytes >= BYTES_IN_KB && bytes % BYTES_IN_KB === 0) return `${bytes / BYTES_IN_KB} KB`;
  return `${bytes} bytes`;
}
