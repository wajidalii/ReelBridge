import { Router } from 'express';

export const configRouter = Router();

// Meta App Review and YouTube API compliance review are external, non-code
// business processes (see PROJECT.md #16) — these flags let the frontend show
// an honest gating notice instead of a broken "connect" button until they
// clear, without a redeploy being required to flip them.
configRouter.get('/', (_req, res) => {
  res.json({
    metaAppReviewApproved: process.env.META_APP_REVIEW_APPROVED === 'true',
    youtubeComplianceApproved: process.env.YOUTUBE_COMPLIANCE_APPROVED === 'true',
  });
});
