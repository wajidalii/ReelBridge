# ReelBridge — Design Notes (Key Screens, Flows, UX Considerations)

No mockups/code here — prose description of flows and the reasoning behind them, generalizing
the prior plan's single-page UI notes (`Login/Signup -> PagesList -> ConnectPage -> PageDetail`)
to a multi-platform, batch-oriented product.

## 1. Onboarding and empty state

First-run experience after signup is a single, clear call to action: "Connect a platform to
get started," with three options presented as equally weighted cards (Facebook, Instagram,
YouTube) even though under the hood Facebook and Instagram share one OAuth flow. The UI should
not expose that shared plumbing to the user — someone who only wants Instagram still clicks
"Connect Instagram," which internally runs the Facebook Login for Business flow and then
narrows the result down to "here's the Instagram Business account we found," rather than
making the user understand Meta's connection model. If no Instagram Business account is found
on the connected Facebook Page, show a plain-language explanation ("this Facebook Page isn't
linked to an Instagram Business account yet") with a link to Meta's own conversion
instructions, not a dead end.

Because Meta App Review and the YouTube compliance audit are real gates (see `TDD.md`/
`PROJECT.md`), pre-launch the UI must be honest about current availability — e.g. a
"currently invite-only while we complete Meta's review" state on the Facebook/Instagram
connect card if the app isn't yet reviewed, rather than presenting a button that will fail for
non-tester accounts. This is a UX-integrity issue, not just a technical one: a broken OAuth
flow with no explanation erodes trust in early access.

## 2. Connecting a Facebook Page (and Instagram, in the same flow)

Same shape as the prior plan's validated flow: OAuth redirect, callback lists Pages found via
`/me/accounts`, each shown as a card with name + avatar + an "Instagram linked" badge if an IG
Business account was discovered off that Page. Because `/me/accounts` can under-report
Business-Portfolio-owned Pages, the "no pages found automatically" state is treated as a
normal, expected outcome, not an error — it always shows a "connect manually" option alongside
whatever was auto-discovered, with an inline, collapsible walkthrough (reusing the guide
already written for the Facebook-only product) for finding a Page ID and generating a token by
hand.

## 3. Connecting a YouTube channel

Simpler, single-purpose Google OAuth flow (no Page/analogous concept — one Google account
generally maps to the channels it manages). After connecting, show the channel name/thumbnail
and, if the underlying API project hasn't cleared its compliance audit yet, a small persistent
notice on that channel's card: "uploads via ReelBridge will currently only be published as
private on YouTube until our API access is fully verified" — this must be visible at the
point of connecting, not discovered only when a scheduled "public" post silently stays
private.

## 4. Uploading a batch

A single upload surface (drag-and-drop or file picker, multiple files at once) creates a
"batch." Each video appears as a row/card with a thumbnail, filename, duration, and detected
resolution as soon as it's processed enough to know those. This is where per-platform
constraint validation surfaces early: if a video's aspect ratio or duration falls outside a
platform's Reels/Shorts sweet spot, a small warning badge appears on that video *for the
platforms it doesn't suit*, before the user even gets to the targeting step — so the
information is available when it's still cheap to swap the file, not after scheduling.

## 5. Assigning targets and captions per video

For each video in the batch, the user picks any combination of connected targets
(Pages/Instagram accounts/YouTube channels) via multi-select. A single "default caption" field
applies to all selected targets by default; an explicit "customize per platform" toggle reveals
one caption field per selected target type. YouTube's target row is visually distinguished by
having a separate title field in addition to the caption/description, since it isn't a single
free-text field the way Facebook/Instagram are — a plain default is auto-suggested from the
first line of the shared caption, editable.

This screen is also where scheduling is chosen, per video: "publish now," "pick a date/time,"
or (batch-level, not per-video) "auto-distribute across the next N days" reusing the
generalized slot-cadence concept. If the user picks a specific time for a target where the
platform's scheduling is app-managed rather than native (currently: Instagram), a small
inline note clarifies that ReelBridge itself will trigger the post at that time rather than
Instagram holding it — set expectations, don't bury the distinction only in a tooltip no one
opens.

## 6. Pre-publish preview / dry run

Before committing a batch, a preview screen lists every resolved (video, target, time,
caption) combination as a plain table/list — this is the dry-run manifest concept from the
prior plan, generalized across platforms. Any validation warnings (aspect ratio, duration,
missing IG Business link, expired token) are shown inline against the specific rows they
affect, and the "Schedule batch" action is disabled (not silently ignored) until blocking
issues are resolved or explicitly acknowledged where they're just warnings rather than hard
failures.

## 7. Unified status dashboard

One filterable list (by platform, target, status, date) is the home view after the first
batch exists, mirroring the prior plan's `ReelsStatus` table but spanning platforms. Status
values distinguish `native_scheduled` (Facebook/YouTube — "the platform will publish this")
from `awaiting_app_managed_publish` (Instagram — "ReelBridge will trigger this"), using
different, consistently-applied icon/label treatment rather than one generic "scheduled"
label, since the two carry different reliability expectations the user should be able to
learn to read at a glance. Failed items show the last error and a one-click retry that
reuses the already-uploaded media asset rather than requiring re-upload.

## 8. Account/token health

A settings-style view lists every connected target with a last-validated timestamp and a
plain-language health state (healthy / needs reconnect / revoked). This generalizes the prior
plan's per-page token-health check to run per target across all three platforms — Facebook
Page tokens, Instagram (inherits Facebook connection health plus its own permission check),
and Google OAuth refresh tokens (which the user can revoke independently from their Google
Account security settings, a failure mode Facebook page tokens don't really have in the same
way). A broken target should never be discovered only because a scheduled post silently
failed — the health check must run proactively and surface a banner before that happens.

## 9. Accessibility notes

- All status distinctions (native-scheduled vs. app-managed, healthy vs. needs-reconnect,
  validation warning vs. blocking error) must be conveyed with text/labels, not color alone,
  given how much of this product's differentiator is precisely these nuanced status
  distinctions.
- The batch upload and per-target assignment screens involve a lot of repeated, similar
  controls (per-video, per-target); keyboard navigation and clear focus order matter more here
  than in a typical single-form app — a power user managing a large batch should be able to
  tab through rows predictably rather than rely on drag-and-drop/mouse-only interactions.
- Drag-and-drop upload must have an equivalent standard file-picker control, not be the only
  path to uploading.
- Inline validation warnings and error text should be programmatically associated with the
  specific video/target row they describe (not just visually adjacent), so screen-reader users
  get the same "this warning is about this exact row" context sighted users get from layout.
