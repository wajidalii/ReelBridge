import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import { getRedisConnection } from './connection.js';

const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();

/** Lazily creates and caches one Queue instance per name so repeated lookups for the same key reuse it. */
export function getQueue<T = unknown>(name: string): Queue<T> {
  const existing = queues.get(name);
  if (existing) {
    return existing as Queue<T>;
  }
  const queue = new Queue<T>(name, { connection: getRedisConnection() });
  queues.set(name, queue as Queue);
  return queue;
}

/** Lazily creates and caches one Worker per name — this is the mechanism behind per-target rate limiting: each key gets its own Worker with its own `limiter`. */
export function getOrCreateWorker<T = unknown>(
  name: string,
  processor: Processor<T>,
  options?: Omit<WorkerOptions, 'connection'>,
): Worker<T> {
  const existing = workers.get(name);
  if (existing) {
    return existing as Worker<T>;
  }
  const worker = new Worker<T>(name, processor, { connection: getRedisConnection(), ...options });
  workers.set(name, worker as Worker);
  return worker;
}

export async function closeAllQueuesAndWorkers(): Promise<void> {
  await Promise.all([...workers.values()].map((worker) => worker.close()));
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  workers.clear();
  queues.clear();
}
