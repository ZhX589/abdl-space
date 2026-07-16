# NBW Timeline API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose NBW `get_sync_threads` as a Mastodon-compatible timeline at `GET /api/v1/timelines/nbw` while retaining the existing custom endpoint.

**Architecture:** A shared handler maps Mastodon pagination parameters to NBW cursor parameters, invokes the S2S API, converts every raw NBW thread through `toStatusFromNBW`, and emits a Mastodon Link header. Both the formal timeline route and legacy route delegate to that handler.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Node test runner.

---

### Task 1: Shared NBW Timeline Handler

**Files:**
- Create: `src/mastodon/nbw-timeline.ts`
- Create: `src/mastodon/nbw-timeline.test.ts`
- Modify: `src/mastodon/routes.ts`
- Modify: `src/mastodon/abdl.ts`
- Modify: `package.json`

- [ ] Write failing tests for `limit`, `max_id`/`cursor`, `fid`, `orderby`, and next Link construction.
- [ ] Run `node --experimental-strip-types --test src/mastodon/nbw-timeline.test.ts` and confirm failure because the module is absent.
- [ ] Implement the shared handler and parameter helpers.
- [ ] Register `GET /timelines/nbw` and delegate the legacy `/nbw/sync-threads` route.
- [ ] Run `npm test` and `npx wrangler deploy --dry-run`.
- [ ] Deploy and verify the production endpoint returns a JSON Status array and a valid next Link when available.
- [ ] Commit only the focused timeline files.
