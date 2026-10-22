import { getLogger } from '@reelbridge/shared';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Small internal interface (issue #38) so the provider can be swapped without touching callers. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Dev/test default: logs the message instead of sending it. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  async send(message: EmailMessage): Promise<void> {
    getLogger().info(
      { email: { to: message.to, subject: message.subject }, body: message.text },
      'email (console provider — not actually sent)',
    );
  }
}

/**
 * Resend's HTTP API via plain fetch — no SDK dependency for a single POST.
 * Postmark/SES/etc. would be another ~20-line class implementing EmailProvider.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend API responded ${res.status}: ${body.slice(0, 200)}`);
    }
  }
}

/** Captures sent messages in memory — for integration tests. */
export class InMemoryEmailProvider implements EmailProvider {
  readonly name = 'memory';
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

let provider: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  if (provider) return provider;
  const kind = process.env.EMAIL_PROVIDER ?? 'console';
  if (kind === 'resend') {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) {
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM');
    }
    provider = new ResendEmailProvider(apiKey, from);
  } else if (kind === 'memory') {
    provider = new InMemoryEmailProvider();
  } else {
    provider = new ConsoleEmailProvider();
  }
  return provider;
}

/** Test hook: inject a provider (e.g. InMemoryEmailProvider) for the current process. */
export function setEmailProviderForTests(next: EmailProvider | undefined): void {
  provider = next;
}
