import bcrypt from 'bcryptjs';

/**
 * bcrypt work factor. 12 is the production default (OWASP's floor is 10);
 * BCRYPT_COST lets test runs use a cheap factor — bcryptjs is pure JS and a
 * cost-12 hash can take seconds on a loaded CI box, which is pure waste when
 * the thing under test isn't the hash itself.
 */
function saltRounds(): number {
  const raw = Number(process.env.BCRYPT_COST ?? 12);
  if (!Number.isInteger(raw)) return 12;
  return Math.min(15, Math.max(4, raw));
}

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, saltRounds());
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
