import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/l/I
const LENGTH = 8;

/** Random slug with no modulo bias: bytes that would skew the distribution are thrown away. */
export function randomSlug(bytes: (n: number) => Buffer = randomBytes): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < LENGTH) {
    for (const b of bytes(LENGTH * 2)) {
      if (b < limit) out += ALPHABET[b % ALPHABET.length];
      if (out.length === LENGTH) break;
    }
  }
  return out;
}
