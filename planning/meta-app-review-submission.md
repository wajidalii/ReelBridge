# Meta App Review Submission Package

Tracks issue #16. Prepared as soon as the Facebook adapter (`packages/platforms/facebook`,
`packages/server/src/modules/connections`) was functionally complete, per `PROJECT.md`'s
directive to start this launch gate early rather than as a post-launch afterthought.

This document is the content to paste into the Meta App Dashboard's review submission form.
Submission itself must be done by whoever holds the Meta Developer account — it isn't something
that can be automated from this repo.

## 1. Use Case configuration

In the Meta App Dashboard, add the **"Manage everything on your Page"** use case (this is what
makes `pages_manage_posts` and `business_management` selectable — confirmed in the manual-token
help text at `packages/client/src/routes/ConnectFacebook.tsx:239`). Add Instagram's equivalent
content-publishing use case for `instagram_content_publish`.

Permissions requested, exactly as configured in
`packages/platforms/facebook/src/oauth.ts:8-15` (`FACEBOOK_OAUTH_SCOPES`):

| Scope | Requires review? |
|---|---|
| `pages_show_list` | No (standard access) |
| `pages_read_engagement` | No (standard access) |
| `pages_manage_posts` | **Yes** |
| `business_management` | **Yes** |
| `instagram_basic` | No (standard access) |
| `instagram_content_publish` | **Yes** |

All six are requested in one OAuth dialog ("Facebook Login for Business") so a single connect
covers both a Facebook Page and any linked Instagram Business account, rather than a second
separate Instagram login — see the comment at `oauth.ts:3-7`.

## 2. Data-use justification per permission

**`pages_manage_posts`**
ReelBridge is a scheduling/cross-posting tool: a user uploads a video once and ReelBridge
publishes it as a Facebook Reel to the Pages they've connected, either immediately or at a
scheduled time. This permission is used exclusively to publish the video the user selected, via
the Reels upload API (`startVideoReelsUpload` / `finishVideoReelsUpload` in
`packages/platforms/facebook/src/upload.ts` and `adapter.ts:100-111`). No other Page-management
action (editing Page info, moderating comments, etc.) is performed with this token.

**`business_management`**
Used to enumerate the Pages a user's Business Portfolio grants them access to
(`fetchUserPages` in `discovery.ts:16-25`, called via `/me/accounts`), so the user can pick which
Page(s) to connect. ReelBridge does not read or modify any other Business Manager asset (ad
accounts, catalogs, other users' permissions).

**`instagram_content_publish`**
Used to publish the same user-selected video as an Instagram Reel to the Instagram Business
account linked to a connected Facebook Page. Discovery of the linked account uses
`fetchPageInstagramAccount` (`discovery.ts:32-43`); publishing goes through the adapter's
`publish()` method, mirroring the Facebook flow. ReelBridge does not read DMs, comments, insights,
or any other Instagram data beyond what's needed to identify the linked Business account and post
to it.

**Data retention note:** access tokens are stored encrypted at rest (AES via `encrypt()`,
`@reelbridge/shared`) and are used only server-side, at publish time, to call the Graph API on the
user's behalf. Tokens are never exposed to the client or third parties.

## 3. Screencast script — connect → publish flow

Meta requires a screencast showing the reviewer's own test Page/Instagram account going through
the real OAuth consent screen and a successful publish. Record this **against a real Meta app in
Development mode with a reviewer added as a test user** — that step needs the team's actual
`FB_APP_ID`/`FB_APP_SECRET` and a live Facebook account, neither of which exists in this
environment, so the actual recording has to happen outside this repo/session.

Steps to capture:

1. Start at `/connect/facebook` (`ConnectFacebook.tsx`). Show the page in its normal state —
   "Connect with Facebook" button visible (this only renders once `metaAppReviewApproved` is
   true / `META_APP_REVIEW_APPROVED=true`; during the review itself, temporarily flip that env var
   in a review/staging environment so the reviewer doesn't just see the manual-entry-only state).
2. Click **Connect with Facebook** → show the Facebook OAuth consent dialog listing the requested
   permissions (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `business_management`, `instagram_basic`, `instagram_content_publish`).
3. Approve, get redirected back to `/connect/facebook?connected=1&pages=N&instagram=N` — show the
   "Connected N Facebook Page(s)" success state.
4. Navigate to the upload/batch flow, select a short vertical video, assign it to the connected
   Facebook Page (and Instagram target if applicable).
5. Publish immediately (or schedule) and show the resulting post live on the actual Facebook
   Page/Instagram account (the permalink from `checkStatus()`'s `permalink_url`, `adapter.ts:135`,
   or just the platform's own UI).
6. Repeat steps 4-5 for Instagram if a separate clip is required by the reviewer's checklist.

## 4. Privacy policy URL & data-use summary

Privacy policy URL: **TBD — not yet present in this repo; add the deployed policy's public URL
here before submitting.**

Data-use summary for the review form: "ReelBridge lets a user connect their own Facebook Pages
and linked Instagram Business accounts, and publishes video content the user explicitly selects
and schedules, to those same accounts. No data is shared with third parties or used for
advertising."

## 5. Manual-token fallback (interim path, non-reviewer users)

Confirmed working end-to-end and covered by integration tests — not just a design intention:

- Gated by `META_APP_REVIEW_APPROVED` (`packages/server/src/modules/config/configRouter.ts:11`):
  while `false`/unset, `ConnectFacebook.tsx` and `Onboarding.tsx` hide the OAuth button and show
  the manual Page-ID/name/token form instead.
- `POST /api/targets/facebook/manual` validates the pasted token against a live Graph API call
  before storing anything, encrypts it, and tags the row `token_source=manual`
  (`manualFacebookTarget.ts`, `upsertFacebookTargets.ts`).
- `facebookManualTarget.integration.test.ts` (4 tests, run against a real Postgres instance)
  passes: valid-token storage, invalid-token rejection, auth requirement, and required-field
  validation. Verified 2026-08-01.

This satisfies the acceptance criterion that non-tester users have a usable interim path while
the review above is pending.

## 6. Submission tracking

| Step | Status |
|---|---|
| Use Case(s) configured in Meta App Dashboard | Not started — requires Dashboard access |
| Screencast recorded | Not started — requires real `FB_APP_ID`/`FB_APP_SECRET` + test account |
| Privacy policy URL finalized | Not started |
| Submitted for `pages_manage_posts`, `business_management`, `instagram_content_publish` | Not started |
| Reviewer feedback | N/A |

Update this table (and issue #16) as each step completes.
