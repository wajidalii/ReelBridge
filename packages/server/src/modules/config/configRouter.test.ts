import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';

describe('GET /api/config', () => {
  const originalMetaFlag = process.env.META_APP_REVIEW_APPROVED;
  const originalYoutubeFlag = process.env.YOUTUBE_COMPLIANCE_APPROVED;

  afterEach(() => {
    process.env.META_APP_REVIEW_APPROVED = originalMetaFlag;
    process.env.YOUTUBE_COMPLIANCE_APPROVED = originalYoutubeFlag;
  });

  it('defaults both gating flags to false when unset', async () => {
    delete process.env.META_APP_REVIEW_APPROVED;
    delete process.env.YOUTUBE_COMPLIANCE_APPROVED;
    const app = createApp();

    const res = await request(app).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      metaAppReviewApproved: false,
      youtubeComplianceApproved: false,
    });
  });

  it('reflects the env vars once they are set to "true"', async () => {
    process.env.META_APP_REVIEW_APPROVED = 'true';
    process.env.YOUTUBE_COMPLIANCE_APPROVED = 'true';
    const app = createApp();

    const res = await request(app).get('/api/config');

    expect(res.body).toEqual({
      metaAppReviewApproved: true,
      youtubeComplianceApproved: true,
    });
  });

  it('treats any non-"true" value as not approved', async () => {
    process.env.META_APP_REVIEW_APPROVED = 'yes';
    const app = createApp();

    const res = await request(app).get('/api/config');

    expect(res.body.metaAppReviewApproved).toBe(false);
  });
});
