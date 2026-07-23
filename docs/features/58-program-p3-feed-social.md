# Feature 58 — Master Program Phase 3 wave 6: Feed social layer (CLOSES PHASE 3)

Adds the social layer to the engagement feed — reactions, threaded comments,
@mentions — and closes a real latent gap: the `Notification` inbox was written
to (announcement + recognition fan-out) but no ESS endpoint ever surfaced it,
so employees never saw in-app notifications. Now @mentions and comment pings
actually land.

## What shipped

### Reactions (single per person per post)
`FeedReaction` (@@unique[announcementId, employeeId] — one reaction each; PUT
replaces the kind; kind is a free string LIKE/CELEBRATE/SUPPORT/INSIGHTFUL/
LOVE so new reactions need no migration). ESS `PUT/DELETE
/me/engagement/feed/:id/reaction`, audience-gated (feedWhereForEmployee — you
can only react to a post you can see). Feed items now carry
`reactionSummary {counts, total, myReaction}`.

### Threaded comments
`FeedComment` (HelpdeskMessage-shaped + parentId for one level of replies +
soft-delete `deletedAt` + `mentionedEmployeeIds[]`). ESS GET (threaded — a
soft-deleted parent with live replies renders as a `[deleted]` placeholder;
deleted leaves vanish), POST (with @mention resolution), PATCH (author-only,
stamps editedAt), DELETE (author soft-delete). Feed items carry `commentCount`
(excludes soft-deleted). Operator moderation: `DELETE
/announcements/feed/comments/:id` under canManageAnnouncements deletes any
comment.

### @mentions
Syntax `@[Full Name]` / `@[EMP-code]` / `@[email]` (bracketed, handles
spaces/dots) or bare `@handle`. Pure parser strips code fences, dedupes,
excludes real emails from bare-handle matches. Resolution runs in-process
against the same fields `/me/directory` searches (code / work+personal email /
preferred / first+last / first name), tenant-scoped — stored as
`mentionedEmployeeIds`.

### The real gap — ESS notification inbox
`NotificationType` gains FEED_MENTION / FEED_COMMENT / FEED_REACTION. On
comment create, in-app `Notification` rows are written (FEED_COMMENT → the post
author's User if ≠ actor; FEED_MENTION → each mentioned employee's User,
distinct, self excluded, author not double-notified). NEW ESS inbox
`GET /me/notifications` (+ `/unread-count`, `/:id/read`, `/read-all`) resolving
the customer session → linked User (graceful `unlinked:true` when the employee
has no operator User). In-app only for v1 (comment/mention pings are
high-volume/low-urgency; the inbox is the source of truth).

### UI
ESS feed card: reaction bar (5 emojis, counts, my-reaction highlighted,
toggle), collapsible comment thread (lazy-loaded, composer + reply, edit/delete
on own comments, @mention autocomplete via /me/directory, mention spans
highlighted). TopBar bell rewired from /me/tasks to the real notification
inbox (unread badge + dropdown, type-aware labels, mark-read / mark-all,
graceful unlinked state; approvals affordance preserved).

## Manual test (staging)
1. ESS → Feed → react to a post (👍) → count updates; react again with 🎉 →
   replaces the first.
2. Comment "Welcome @[Jane Doe]!" → Jane sees a bell notification; the comment
   count updates; edit shows "(edited)"; reply nests.
3. Bell → the mention appears → click → lands on the feed → mark all read.

## E2E evidence
`qa/e2e/e2e-p3-feed.js` on live staging: announcement post/publish, feed
reactionSummary/commentCount, react LIKE → replace with CELEBRATE (single-per-
person) → bad-kind 400, @mention comment (mentionedEmployeeIds resolved) +
threaded reply + edit, feed counts reflect, the mention notification LANDS in
Meera's inbox (unread → mark read), unknown-post 404, cleanup. Units:
feedSocial 42 (parser, aggregator, thread assembler, notification targets).
