# ReelBridge — Proposed Repository Structure

Monorepo, generalizing the prior plan's layout from a single Facebook integration to a
platform-adapter shape. Package-manager workspaces (npm/pnpm workspaces), one repo.

```
reelbridge/
├── docker-compose.yml            # local dev: api, worker, postgres, redis, minio (S3-compatible, dev-only)
├── package.json                  # workspaces root
├── packages/
│   ├── shared/                   # Zod schemas, shared TS types, slot/cadence algorithm,
│   │                             # PlatformAdapter interface + capability descriptors
│   │                             # (rationale: server, worker, and platform adapters all need
│   │                             # the same request/response and DB-row shapes; keeping them
│   │                             # here avoids drift between packages)
│   │
│   ├── platforms/                # one subpackage per platform, each implementing PlatformAdapter
│   │   ├── facebook/             # Graph API client: 3-phase /video_reels upload, OAuth,
│   │   │                         # /me/accounts + manual-entry fallback (ported from SAAS_PLAN.md)
│   │   ├── instagram/            # container create/poll/publish, signed-URL fetch requirement,
│   │   │                         # content_publishing_limit checks, IG discovery off a Facebook
│   │   │                         # connection
│   │   └── youtube/              # resumable upload client, Google OAuth, publishAt scheduling,
│   │                             # quota-aware backoff
│   │                             # (rationale: isolating each platform's Graph/Data-API quirks
│   │                             # in its own package is what makes "add a 4th platform later"
│   │                             # a new sibling package, not a change to server/worker internals)
│   │
│   ├── server/                   # Express API — auth, connections, targets, media, batches,
│   │   │                         # dashboard; imports packages/shared and packages/platforms
│   │   │                         # only for OAuth-start/callback + read-only validation calls
│   │   │                         # (never does the actual publish work itself)
│   │   └── src/{db,modules,storage,queues,app.ts,server.ts}
│   │
│   ├── worker/                   # BullMQ worker process — separate entrypoint/deployable,
│   │   │                         # imports packages/shared + packages/platforms for the actual
│   │   │                         # publish/poll work
│   │   └── src/{processors/{scheduleBatch.ts,publishToTarget.ts,pollStatus.ts,topupSchedule.ts},worker.ts}
│   │                             # (rationale: keeping worker as its own deployable, same as the
│   │                             # prior FB-only plan, is what lets it scale independently of
│   │                             # the API and rate-limit per platform/target without the API
│   │                             # tier's traffic patterns interfering)
│   │
│   └── client/                   # React app (Vite)
│       └── src/{routes,components,hooks,api}
│                                 # (rationale: kept as its own package rather than folded into
│                                 # server so it can be deployed/CDN-hosted independently of the
│                                 # API/worker tiers)
│
├── planning/                     # this planning doc set (PRD, TDD, PROJECT, structure, design)
│                                 # (rationale: keeps product/technical planning versioned next
│                                 # to the code it describes, separate from the older
│                                 # single-platform SAAS_PLAN.md this supersedes)
│
└── SAAS_PLAN.md                  # retained as historical record of the validated Facebook-only
                                  # plan and the hand-tested Graph API details it carries;
                                  # not deleted, since packages/platforms/facebook is built
                                  # directly against it
```

Notes on the two structural changes versus the prior single-platform layout:

- **`packages/platforms/` is new.** The prior plan folded Facebook-specific code directly
  into `worker/src/facebook` and a bit of `server/src/modules`. With three platforms sharing
  a common `PlatformAdapter` interface (see `TDD.md` §2), giving each platform its own
  installable package makes the adapter boundary a real module boundary, not just a
  file-naming convention, and keeps `server`/`worker` free of any platform-specific
  branching.
- **`shared` now also owns the adapter interface and capability descriptors**, not just Zod
  schemas and the slot algorithm, because both `server` (for validation/preview) and `worker`
  (for actual publishing) need to reason about a target's capabilities (native scheduling?
  max lead time? caption shape?) without importing a specific platform package directly.

Everything else (docker-compose dev stack, server/worker/client split, migrations-on-boot,
secrets handling) is unchanged from `SAAS_PLAN.md` and is not re-justified here.
