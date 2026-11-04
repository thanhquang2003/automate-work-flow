import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, hashPassword, verifyPassword } from '../../src/security/crypto.js';

describe('crypto', () => {
  it('encrypt/decrypt roundtrip and tamper throws', () => {
    const blob = encrypt('glpat-secret', 'my-key');
    expect(blob).not.toContain('glpat-secret');
    expect(decrypt(blob, 'my-key')).toBe('glpat-secret');
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] ^= 1;
    expect(() => decrypt(buf.toString('base64'), 'my-key')).toThrow();
    expect(() => decrypt(blob, 'other-key')).toThrow();
  });

  it('hashes and verifies passwords', () => {
    const h = hashPassword('pw123');
    expect(verifyPassword('pw123', h)).toBe(true);
    expect(verifyPassword('nope', h)).toBe(false);
  });
});
