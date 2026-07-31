import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, generateEncryptionKey } from './crypto.js';

describe('crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const key = Buffer.from(generateEncryptionKey(), 'base64');
    const plaintext = 'super-secret-page-access-token';

    const encrypted = encrypt(plaintext, key);
    expect(encrypted.ciphertext).not.toBe(plaintext);

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('produces a different ciphertext and iv on every call (random IV)', () => {
    const key = Buffer.from(generateEncryptionKey(), 'base64');
    const plaintext = 'same-plaintext';

    const first = encrypt(plaintext, key);
    const second = encrypt(plaintext, key);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('fails to decrypt with the wrong key', () => {
    const key = Buffer.from(generateEncryptionKey(), 'base64');
    const wrongKey = Buffer.from(generateEncryptionKey(), 'base64');
    const encrypted = encrypt('some-token', key);

    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('fails to decrypt tampered ciphertext (auth tag mismatch)', () => {
    const key = Buffer.from(generateEncryptionKey(), 'base64');
    const encrypted = encrypt('some-token', key);
    const tampered = { ...encrypted, ciphertext: Buffer.from('tampered').toString('base64') };

    expect(() => decrypt(tampered, key)).toThrow();
  });
});
