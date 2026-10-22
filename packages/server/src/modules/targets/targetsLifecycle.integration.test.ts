import 'dotenv/config';
import {
  encrypt,
  getDb,
  getPool,
  getQueue,
  mediaAssets,
  platformConnections,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
  scheduleConfigs,
  TOPUP_SCHEDULE_QUEUE_NAME,
  users,
} from '@reelbridge/shared';
import { eq, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { signAccessToken } from '../auth/jwt.js';

process.env.JWT_SECRET ||= 'test-jwt-secret-for-integration-tests-only';
process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';

const TEST_EMAIL_PREFIX = 'reelbridge-targets-lifecycle-test+';

async function isDatabaseReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
async function isRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}
const ready = (await Promise.all([isDatabaseReachable(), isRedisReachable()])).every(Boolean);

async function createUserWithTargets(email: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
  if (!user) throw new Error('user');
  const [fbConn] = await db
    .insert(platformConnections)
    .values({
      userId: user.id,
      platform: 'facebook',
      externalAccountId: 'me',
      displayName: 'Facebook',
      accessTokenCiphertext: 'x',
      accessTokenIv: 'x',
      accessTokenTag: 'x',
    })
    .returning();
  const [googleConn] = await db
    .insert(platformConnections)
    .values({
      userId: user.id,
      platform: 'google',
      externalAccountId: 'me',
      displayName: 'Google',
      accessTokenCiphertext: 'x',
      accessTokenIv: 'x',
      accessTokenTag: 'x',
      status: 'revoked',
    })
    .returning();
  const token = encrypt('tok');
  const [page] = await db
    .insert(publishTargets)
    .values({
      userId: user.id,
      platformConnectionId: fbConn!.id,
      platform: 'facebook_page',
      externalId: `page-${email}`,
      displayName: 'Page',
      accessTokenCiphertext: token.ciphertext,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      lastValidatedAt: new Date(),
    })
    .returning();
  const [ig] = await db
    .insert(publishTargets)
    .values({
      userId: user.id,
      platformConnectionId: fbConn!.id,
      platform: 'instagram_business',
      externalId: `ig-${email}`,
      displayName: 'IG',
      isActive: false,
      metadata: { linkedFacebookPageId: `page-${email}`, lastHealthError: 'boom' },
    })
    .returning();
  const [yt] = await db
    .insert(publishTargets)
    .values({
      userId: user.id,
      platformConnectionId: googleConn!.id,
      platform: 'youtube_channel',
      externalId: `yt-${email}`,
      displayName: 'Channel',
    })
    .returning();
  return { user, fbConn: fbConn!, googleConn: googleConn!, page: page!, ig: ig!, yt: yt! };
}

function cookieFor(userId: string) {
  return [`reelbridge_access_token=${signAccessToken(userId)}`];
}

describe.skipIf(!ready)(
  'targets lifecycle: health view, delete, schedule config, connections, dashboard',
  () => {
    const app = createApp();

    afterAll(async () => {
      const db = getDb();
      const testUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
      const ids = testUsers.map((u) => u.id);
      if (ids.length > 0) {
        const batches = await db
          .select({ id: postBatches.id })
          .from(postBatches)
          .where(inArray(postBatches.userId, ids));
        const batchIds = batches.map((b) => b.id);
        if (batchIds.length > 0) {
          const items = await db
            .select({ id: postItems.id })
            .from(postItems)
            .where(inArray(postItems.batchId, batchIds));
          const itemIds = items.map((i) => i.id);
          if (itemIds.length > 0)
            await db.delete(postTargets).where(inArray(postTargets.postItemId, itemIds));
          await db.delete(postItems).where(inArray(postItems.id, itemIds));
          await db.delete(postBatches).where(inArray(postBatches.id, batchIds));
        }
        await db.delete(mediaAssets).where(inArray(mediaAssets.userId, ids));
        await db.delete(publishTargets).where(inArray(publishTargets.userId, ids));
        await db.delete(platformConnections).where(inArray(platformConnections.userId, ids));
        await db.delete(users).where(inArray(users.id, ids));
      }
      await getPool().end();
    });

    it('GET /api/targets derives a text health state per target from is_active + connection status', async () => {
      const { user, page, ig, yt } = await createUserWithTargets(
        `${TEST_EMAIL_PREFIX}health-${Date.now()}@example.com`,
      );
      const res = await request(app).get('/api/targets').set('Cookie', cookieFor(user.id));
      expect(res.status).toBe(200);
      const byId = new Map(res.body.map((t: { id: string }) => [t.id, t]));
      expect(byId.get(page.id)).toMatchObject({ health: 'healthy', platform: 'facebook_page' });
      expect(byId.get(ig.id)).toMatchObject({
        health: 'needs_reconnect',
        lastHealthError: 'boom',
        linkedFacebookPageId: page.externalId,
      });
      // YouTube's health is the Google connection's — revoked there means revoked here.
      expect(byId.get(yt.id)).toMatchObject({ health: 'revoked', connectionStatus: 'revoked' });
      // Secrets never leave the API.
      expect(JSON.stringify(res.body)).not.toContain('Ciphertext');
    });

    it('DELETE /api/targets/:id removes only the caller’s target; another user gets 404', async () => {
      const owner = await createUserWithTargets(
        `${TEST_EMAIL_PREFIX}del-${Date.now()}@example.com`,
      );
      const other = await createUserWithTargets(
        `${TEST_EMAIL_PREFIX}other-${Date.now()}@example.com`,
      );

      const forbidden = await request(app)
        .delete(`/api/targets/${owner.page.id}`)
        .set('Cookie', cookieFor(other.user.id));
      expect(forbidden.status).toBe(404);

      const ok = await request(app)
        .delete(`/api/targets/${owner.page.id}`)
        .set('Cookie', cookieFor(owner.user.id));
      expect(ok.status).toBe(204);
      const [row] = await getDb()
        .select()
        .from(publishTargets)
        .where(eq(publishTargets.id, owner.page.id));
      expect(row).toBeUndefined();
    });

    it('schedule config: PUT validates, caps Instagram at 7 days, GET round-trips, trigger enqueues a topup job', async () => {
      const { user, ig, page } = await createUserWithTargets(
        `${TEST_EMAIL_PREFIX}sched-${Date.now()}@example.com`,
      );
      const cookie = cookieFor(user.id);

      const bad = await request(app)
        .put(`/api/targets/${ig.id}/schedule/config`)
        .set('Cookie', cookie)
        .send({ daily_slots: ['25:00'], timezone: 'Mars/Olympus' });
      expect(bad.status).toBe(400);

      const noConfigTrigger = await request(app)
        .post(`/api/targets/${ig.id}/schedule/trigger`)
        .set('Cookie', cookie);
      expect(noConfigTrigger.status).toBe(400);

      const put = await request(app)
        .put(`/api/targets/${ig.id}/schedule/config`)
        .set('Cookie', cookie)
        .send({
          daily_slots: ['18:00', '09:00', '09:00'],
          timezone: 'America/New_York',
          max_schedule_days: 60,
          cadence: 'every_6_hours',
        });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        dailySlots: ['09:00', '18:00'],
        timezone: 'America/New_York',
        maxScheduleDays: 7,
        cadence: 'every_6_hours',
        isEnabled: true,
        platformMaxScheduleDays: 7,
      });

      const fbPut = await request(app)
        .put(`/api/targets/${page.id}/schedule/config`)
        .set('Cookie', cookie)
        .send({ daily_slots: ['12:00'], timezone: 'UTC', max_schedule_days: 60 });
      expect(fbPut.body.maxScheduleDays).toBe(29);

      const get = await request(app)
        .get(`/api/targets/${ig.id}/schedule/config`)
        .set('Cookie', cookie);
      expect(get.status).toBe(200);
      expect(get.body.config.dailySlots).toEqual(['09:00', '18:00']);
      expect(get.body.recentRuns).toEqual([]);

      const trigger = await request(app)
        .post(`/api/targets/${ig.id}/schedule/trigger`)
        .set('Cookie', cookie);
      expect(trigger.status).toBe(202);
      const queue = getQueue<{ publishTargetId: string }>(TOPUP_SCHEDULE_QUEUE_NAME);
      const job = await queue.getJob(`topup-${ig.id}`);
      expect(job?.data).toMatchObject({ publishTargetId: ig.id, triggeredBy: 'manual' });
      await job?.remove();
      await getDb().delete(scheduleConfigs).where(eq(scheduleConfigs.publishTargetId, ig.id));
    });

    it('GET /api/connections lists providers with active target counts; DELETE cascades to targets', async () => {
      const { user, fbConn, page } = await createUserWithTargets(
        `${TEST_EMAIL_PREFIX}conn-${Date.now()}@example.com`,
      );
      const cookie = cookieFor(user.id);
      const list = await request(app).get('/api/connections').set('Cookie', cookie);
      expect(list.status).toBe(200);
      const fb = list.body.find((c: { id: string }) => c.id === fbConn.id);
      // page is active, the IG target under the same connection is inactive.
      expect(fb).toMatchObject({ platform: 'facebook', targetCount: 1, status: 'active' });
      expect(JSON.stringify(list.body)).not.toContain('Ciphertext');

      const del = await request(app).delete(`/api/connections/${fbConn.id}`).set('Cookie', cookie);
      expect(del.status).toBe(204);
      const [row] = await getDb()
        .select()
        .from(publishTargets)
        .where(eq(publishTargets.id, page.id));
      expect(row).toBeUndefined();
    });

    it('GET /api/dashboard summarizes per-platform counts, attention list and upcoming posts', async () => {
      const { user, page } = await createUserWithTargets(
        `${TEST_EMAIL_PREFIX}dash-${Date.now()}@example.com`,
      );
      const db = getDb();
      const [batch] = await db
        .insert(postBatches)
        .values({ userId: user.id, name: 'b' })
        .returning();
      const [media] = await db
        .insert(mediaAssets)
        .values({ userId: user.id, originalFilename: 'a.mp4', storageKey: 'k', fileSizeBytes: 1 })
        .returning();
      const [item] = await db
        .insert(postItems)
        .values({ batchId: batch!.id, mediaAssetId: media!.id, defaultCaption: 'c' })
        .returning();
      await db.insert(postTargets).values([
        {
          postItemId: item!.id,
          publishTargetId: page.id,
          status: 'native_scheduled',
          scheduledAt: new Date(Date.now() + 3600_000),
        },
        { postItemId: item!.id, publishTargetId: page.id, status: 'failed', lastError: 'nope' },
      ]);

      const res = await request(app).get('/api/dashboard').set('Cookie', cookieFor(user.id));
      expect(res.status).toBe(200);
      expect(res.body.targets).toMatchObject({ total: 3, active: 1 });
      expect(res.body.targets.needsAttention).toHaveLength(2);
      expect(res.body.posts.countsByPlatform.facebook_page).toEqual({
        native_scheduled: 1,
        failed: 1,
      });
      expect(res.body.upcoming).toHaveLength(1);
      expect(res.body.recentFailures[0]).toMatchObject({ lastError: 'nope' });
      expect(res.body.batches.total).toBe(1);
    });

    it('GET /api/billing/usage reports plan + counts; limits enforce only when switched on', async () => {
      const { user } = await createUserWithTargets(
        `${TEST_EMAIL_PREFIX}usage-${Date.now()}@example.com`,
      );
      const cookie = cookieFor(user.id);
      const usage = await request(app).get('/api/billing/usage').set('Cookie', cookie);
      expect(usage.status).toBe(200);
      // Plan limits count is_active rows (page + the still-flagged-active YouTube channel).
      expect(usage.body).toMatchObject({ activeTargets: 2, postsThisMonth: 0, enforced: false });

      const { checkUsageLimit, UsageLimitError } = await import('../billing/checkUsageLimit.js');
      await expect(checkUsageLimit(user.id, 'connect_target', 1000)).resolves.toBeUndefined();

      process.env.PLAN_LIMITS_ENFORCED = 'true';
      try {
        // The seeded default plan may or may not exist locally; with no plan the
        // limit is unlimited, with the Free plan (1 target) a second target trips it.
        const effective = await request(app).get('/api/billing/usage').set('Cookie', cookie);
        if (effective.body.plan.maxTargets <= 1) {
          await expect(checkUsageLimit(user.id, 'connect_target')).rejects.toBeInstanceOf(
            UsageLimitError,
          );
          const res = await request(app)
            .post('/api/targets/facebook/manual')
            .set('Cookie', cookie)
            .send({ page_id: '1234567890', name: 'x', access_token: 'y' });
          expect(res.status).toBe(402);
          expect(res.body.code).toBe('plan_limit_reached');
        } else {
          await expect(checkUsageLimit(user.id, 'connect_target')).resolves.toBeUndefined();
        }
      } finally {
        delete process.env.PLAN_LIMITS_ENFORCED;
      }
    });
  },
);
