import { afterEach, describe, expect, it } from 'vitest';
import { isSignupAllowed, signupMode } from './signupGating.js';

describe('signup gating (issue #40)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.SIGNUP_MODE = saved.SIGNUP_MODE;
    process.env.SIGNUP_INVITE_CODES = saved.SIGNUP_INVITE_CODES;
    process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS = saved.SIGNUP_ALLOWED_EMAIL_DOMAINS;
  });

  it('defaults to open signup', () => {
    delete process.env.SIGNUP_MODE;
    expect(signupMode()).toBe('open');
    expect(isSignupAllowed('anyone@example.com', undefined)).toBe(true);
  });

  it('in invite mode admits only a valid code or an allowlisted domain', () => {
    process.env.SIGNUP_MODE = 'invite';
    process.env.SIGNUP_INVITE_CODES = 'alpha-1, beta-2';
    process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS = 'Trusted.example';
    expect(isSignupAllowed('x@example.com', undefined)).toBe(false);
    expect(isSignupAllowed('x@example.com', 'wrong')).toBe(false);
    expect(isSignupAllowed('x@example.com', 'beta-2')).toBe(true);
    expect(isSignupAllowed('x@trusted.example', undefined)).toBe(true);
  });
});
