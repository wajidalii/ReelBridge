import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  default: { schedule: (...args: unknown[]) => scheduleMock(...args) },
}));

const { startScheduleTrigger } = await import('./trigger.js');

describe('startScheduleTrigger', () => {
  it('registers the cron expression and invokes the callback on tick', async () => {
    const enqueueDueJobs = vi.fn().mockResolvedValue(undefined);
    startScheduleTrigger(enqueueDueJobs, '*/1 * * * *');

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const [expression, tickHandler] = scheduleMock.mock.calls[0] as [string, () => void];
    expect(expression).toBe('*/1 * * * *');

    tickHandler();
    await vi.waitFor(() => expect(enqueueDueJobs).toHaveBeenCalledTimes(1));
  });

  it('logs rather than throwing if enqueueDueJobs rejects', async () => {
    const error = new Error('db unavailable');
    const enqueueDueJobs = vi.fn().mockRejectedValue(error);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    startScheduleTrigger(enqueueDueJobs);
    const lastCall = scheduleMock.mock.calls.at(-1) as [string, () => void];
    const tickHandler = lastCall[1];
    tickHandler();

    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    consoleErrorSpy.mockRestore();
  });
});
