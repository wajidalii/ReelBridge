# ReelBridge — Project Overview

## Vision

ReelBridge is the place a creator or small team drops a batch of short-form videos once and
walks away, trusting that each clip lands on the right Facebook Page, Instagram account, and
YouTube channel, with the right caption per platform, at the right time — without three
separate uploads and three separate scheduling UIs.

## Business goals

- Validate the "bridge" premise (bulk fan-out across platforms, not just single-platform
  scheduling) with a small paying/early-access cohort before investing in team features.
- Keep the product legally/operationally sustainable under each platform's developer terms
  (Meta App Review, YouTube API Services compliance) rather than shipping something that
  works in a test/tester-only mode indefinitely.
- Preserve the option to monetize via tiered plans (targets connected, posts/month) without
  having built billing enforcement prematurely — schema-ready, Stripe wiring deferred.
- Do not take on scope that was proven infeasible during planning research (personal Facebook
  profile posting) — a smaller, honest MVP beats a bigger one that quietly can't do what it
  claims.

## Constraints

- **Platform policy constraints, not engineering choices**: Facebook Pages-only (no personal
  profiles — Graph API removed that capability in 2018 and has not restored it); Instagram
  Business/Creator accounts only, linked to a Facebook Page; YouTube uploads capped at
  `private` visibility until a compliance audit passes.
- **Two independent, slow, non-engineering launch gates**: Meta App Review and the YouTube
  API Services compliance audit. Both must be submitted early since review turnaround is
  external and not something engineering velocity can shorten. Treat "submit for review" as a
  milestone on the critical path, not a post-launch afterthought.
- **Scale target carried from the prior plan**: designed for thousands of users/targets from
  day one — this is why BullMQ+Redis and a separately-scalable worker service are non-
  negotiable even for an early-access launch, not something to retrofit later.
- **No ffmpeg/video-processing scope**: users must bring already-conforming files; ReelBridge
  validates and warns, it does not transcode.
- **Solo/small-team engineering capacity** (inferred from repo context — one operator carrying
  this forward from a personal automation project): favor the adapter-interface architecture
  specifically because it lets Facebook (already de-risked) ship first while Instagram/YouTube
  adapters are built and reviewed in parallel, rather than gating all three on each other.

## Non-functional requirements

- **Reliability**: scheduled-post delivery should be resilient to a worker restart (BullMQ
  redelivery, same as prior plan) — but Instagram's app-managed scheduling means "resilient"
  there specifically means "recovers and publishes late," not "the platform holds it for us,"
  and this distinction should be monitored as its own SLO, not folded into one blended number.
- **Multi-tenant isolation**: no user can read or act on another user's connections, targets,
  media, or posts, enforced at the query layer (`assertTargetOwnership`), verified by
  automated tests, not just UI hiding.
- **Security**: all OAuth tokens (Facebook, Google) encrypted at rest (AES-256-GCM), distinct
  secrets for encryption key / app secrets / JWT signing, never logged; signed short-lived
  URLs for the Instagram fetch step rather than public buckets.
- **Observability**: per-platform success/failure/latency metrics kept separate (not blended)
  given the structurally different reliability profile of Instagram vs. Facebook/YouTube;
  alerting on stuck `awaiting_app_managed_publish` items past a threshold.
- **Horizontal scalability**: API and worker independently replicable; job queue rate-limited
  per external account/project, not globally, so one noisy tenant/platform doesn't starve
  others.
- **Data durability**: media assets in durable object storage, not local disk, from day one.

## Milestones and rough roadmap

1. **Foundations** — auth, multi-tenant schema, S3/R2 storage adapter, BullMQ+Redis
   scaffolding, CI. (Directly reuses prior plan's decisions; low new risk.)
2. **Facebook adapter end-to-end** — OAuth connect flow (with manual fallback), 3-phase
   upload, native scheduling, status polling. This is the least risky integration since it's
   already hand-validated; ship it first to get a working core loop early.
3. **Submit Meta App Review** — as early as the Facebook adapter is functionally complete,
   in parallel with further engineering, since review turnaround is external and unpredictable.
4. **Bulk batch + fan-out UX** — media upload batch flow, per-item target assignment,
   caption/title override model, dry-run preview, unified dashboard — built against Facebook
   first, but with the adapter interface already generalized so Instagram/YouTube slot in
   without UI rework.
5. **YouTube adapter** — Google OAuth, resumable upload, native `publishAt` scheduling.
   Submit for YouTube API Services compliance audit as soon as the integration is functional,
   in parallel with Instagram work, since it's an independent, external-turnaround gate like
   Meta's.
6. **Instagram adapter** — container-based publish flow via the Facebook connection, signed
   URL generation for the url-fetch requirement, and the app-managed scheduling worker
   (due-job poller, lateness alerting) that this platform specifically requires.
7. **Early access launch** — trusted/tester users only until both external reviews clear;
   manual-token fallback keeps Facebook usable in the interim, YouTube usable in
   private-only mode in the interim.
8. **Public launch** — once Meta App Review and the YouTube compliance audit both clear,
   remove the tester-only restriction.
9. **Billing enforcement (post-MVP)** — wire Stripe into the existing `plans`/`subscriptions`
   schema and `checkUsageLimit` call sites.
10. **Team/org sharing, additional platforms, analytics (post-MVP, order not yet committed)**.

Milestones 3 and 5 (the two external review submissions) are the most schedule-risky items
in the whole roadmap because their timeline isn't controlled by ReelBridge's own engineering
pace — they should be started the moment each adapter is functionally testable, not deferred
until "everything else is done."
