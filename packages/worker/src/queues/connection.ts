import { Redis } from 'ioredis';

let sharedConnection: Redis | undefined;

/**
 * BullMQ requires maxRetriesPerRequest: null on the connection it's given.
 * One shared connection is reused across all queues/workers in this process.
 */
export function getRedisConnection(): Redis {
  if (!sharedConnection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL environment variable is not set');
    }
    sharedConnection = new Redis(url, { maxRetriesPerRequest: null });
  }
  return sharedConnection;
}

export async function closeRedisConnection(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.quit();
    sharedConnection = undefined;
  }
}
