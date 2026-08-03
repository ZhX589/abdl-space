# COS Direct Upload Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure Tencent COS presigned uploads, persistent original/preview metadata, and explicit imgbed fallback while preserving old App compatibility.

**Architecture:** A pure COS V5 signing module generates bounded PUT/HEAD requests. Upload records in D1 bind server-generated object keys to users and purposes. New clients authorize, PUT directly to COS, then complete; old multipart endpoints proxy to COS without automatic imgbed fallback.

**Tech Stack:** Hono, Cloudflare Workers, D1, Web Crypto, Tencent COS REST API, Node test runner, Wrangler.

---

### Task 1: COS V5 Signing Core

**Covers:** [S2, S3, S9]

**Files:**
- Create: `src/lib/tencent-cos.ts`
- Create: `src/lib/tencent-cos.test.ts`
- Modify: `src/types/index.ts:347-387`
- Modify: `package.json:6-13`

- [ ] **Step 1: Write failing deterministic signing tests**

Test canonical lowercase headers, encoded object path, five-minute key time, and stable `q-sign-*` authorization fields with fixed clock/credentials. Also test `buildCosPublicUrl('media/a b.jpg')` returns the encoded default COS URL and rejects keys containing `..`.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --experimental-strip-types --test src/lib/tencent-cos.test.ts`

Expected: module/functions are missing.

- [ ] **Step 3: Implement Web Crypto COS signing**

Implement SHA-1 and HMAC-SHA1 with `crypto.subtle`, canonical request:

```text
put\n/<encoded-key>\n\ncontent-type=<encoded>&host=<encoded>\n
```

and Tencent COS V5 authorization fields `q-sign-algorithm=sha1`, `q-ak`, `q-sign-time`, `q-key-time`, `q-header-list=content-type;host`, empty `q-url-param-list`, and `q-signature`. Export `createCosPutAuthorization`, `createCosHeadAuthorization`, `buildCosObjectUrl`, and `putObjectToCos`.

- [ ] **Step 4: Add dedicated Env fields**

Add `COS_SECRET_ID`, `COS_SECRET_KEY`, `COS_BUCKET`, `COS_REGION`, and optional `COS_PUBLIC_ORIGIN`. Do not reuse SES credential fields.

- [ ] **Step 5: Run tests GREEN and add them to npm test**

Run: `node --experimental-strip-types --test src/lib/tencent-cos.test.ts`

Expected: all COS signing tests pass.

- [ ] **Step 6: Commit**

Commit message: `feat(media): 添加腾讯云 COS 请求签名`

### Task 2: Upload Records And Preview Metadata

**Covers:** [S4, S6, S7, S9]

**Files:**
- Create: `migrations/0042_cos_uploads.sql`
- Modify: `schemas/schema.sql:336-349`
- Create: `src/lib/media-upload.ts`
- Create: `src/lib/media-upload.test.ts`

- [ ] **Step 1: Write failing upload-policy tests**

Cover allowed purposes `status_original`, `status_preview`, `avatar`, `header`, `generic`, `release`; MIME/size limits; 540px preview metadata requirement; server-generated keys; five-minute expiry; and ownership/status transitions `pending -> complete`.

- [ ] **Step 2: Verify RED**

Run: `node --experimental-strip-types --test src/lib/media-upload.test.ts`

- [ ] **Step 3: Add migration**

Create `media_uploads` with `id`, `user_id`, `purpose`, `object_key`, `public_url`, `preview_upload_id`, `mime_type`, `declared_size`, `verified_size`, `width`, `height`, `blurhash`, `storage_provider`, `status`, `created_at`, `expires_at`, and unique object key. Add nullable `preview_url` and `storage_provider` to `post_images`.

- [ ] **Step 4: Implement policy/key helpers**

Generate keys under `media/original/`, `media/preview/`, `profile/avatar/`, `profile/header/`, `generic/`, and `releases/`, using authenticated user ID, UTC date, `crypto.randomUUID()`, and MIME-derived extension. Reject client object keys.

- [ ] **Step 5: Run migration/policy tests GREEN**

Run: `node --experimental-strip-types --test src/lib/media-upload.test.ts`

- [ ] **Step 6: Commit**

Commit message: `feat(media): 持久化 COS 上传与缩略图元数据`

### Task 3: Authorize And Complete API

**Covers:** [S3, S4, S5, S7, S9]

**Files:**
- Create: `src/routes/uploads.ts`
- Create: `src/routes/uploads.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing route tests**

Test authenticated authorization returns upload ID, PUT URL, public URL, expiry, and required `Content-Type`; unauthorized, bad MIME, oversize, and arbitrary key are rejected. Completion must sign HEAD, compare size/type, enforce owner, require linked preview for status images, and return `Attachment` with original and preview URLs.

- [ ] **Step 2: Verify RED**

Run: `node --experimental-strip-types --test src/routes/uploads.test.ts`

- [ ] **Step 3: Implement routes**

Mount:

```text
POST /api/v1/uploads/authorize
POST /api/v1/uploads/:id/complete
```

Use existing Mastodon auth for App media and auth middleware for generic/profile calls. Return structured stage error codes without exposing authorization URLs in logs.

- [ ] **Step 4: Add release authorization**

Allow `purpose=release` only with existing release upload key/admin authorization. Return JSON suitable for the release script.

- [ ] **Step 5: Run tests GREEN**

Run: `node --experimental-strip-types --test src/routes/uploads.test.ts`

- [ ] **Step 6: Commit**

Commit message: `feat(media): 提供 COS 预签名直传协议`

### Task 4: Mastodon Status And Legacy Multipart Compatibility

**Covers:** [S4, S6, S7, S10]

**Files:**
- Modify: `src/mastodon/routes.ts:69-110, 810-930, 1727-1815`
- Modify: `src/mastodon/converter.ts:95-228`
- Modify: `src/mastodon/status-create.test.ts`
- Create: `src/mastodon/cos-media.test.ts`

- [ ] **Step 1: Write failing compatibility tests**

Test completed COS upload IDs are accepted as `media_ids`, persist original/preview/provider, and render COS `preview_url`. Historical rows without preview retain v3 fallback. Pending, expired, wrong-owner uploads are rejected. Existing HTTPS legacy URLs remain accepted.

- [ ] **Step 2: Verify RED**

Run: `node --experimental-strip-types --test src/mastodon/cos-media.test.ts src/mastodon/status-create.test.ts`

- [ ] **Step 3: Update status persistence/converter**

Load `preview_url` and `storage_provider` in every post/comment image query. Pass persisted preview into `toMediaAttachment`; use `buildMediaPreviewUrl(url)` only when preview is null.

- [ ] **Step 4: Keep old multipart `/media` using COS proxy**

Generate BlurHash, upload the received file with `putObjectToCos`, create/complete a media record, and return a compatible attachment. Do not call imgbed automatically. Add an explicit request flag/header for user-confirmed imgbed fallback that preserves the existing code path.

- [ ] **Step 5: Update attachment PUT**

Resolve upload record by media ID/public URL and return persisted preview URL instead of rebuilding it.

- [ ] **Step 6: Run tests GREEN**

Run: `node --experimental-strip-types --test src/mastodon/cos-media.test.ts src/mastodon/status-create.test.ts src/mastodon/media-preview.test.ts`

- [ ] **Step 7: Commit**

Commit message: `feat(media): 接入 COS 媒体与旧客户端兼容`

### Task 5: Profile, Generic Images, APK And Cleanup

**Covers:** [S5, S6, S9, S10]

**Files:**
- Modify: `src/mastodon/routes.ts:307-413`
- Modify: `src/routes/images.ts`
- Modify: `src/routes/version.ts`
- Modify: `src/api-worker.ts`
- Create: `src/routes/cos-uploads-integration.test.ts`

- [ ] **Step 1: Write failing integration tests**

Test profile URLs must reference completed owned avatar/header uploads; generic upload endpoints return authorization instead of proxying; delete signs COS DELETE only for owned records; version JSON accepts completed release upload; expired pending cleanup does not delete completed objects.

- [ ] **Step 2: Verify RED**

Run: `node --experimental-strip-types --test src/routes/cos-uploads-integration.test.ts`

- [ ] **Step 3: Implement business integrations**

Keep multipart profile and `/api/images/upload` only as legacy compatibility routes. New JSON paths consume completed upload IDs/URLs. Version upload accepts `apkUrl` only when linked to a completed release record.

- [ ] **Step 4: Add scheduled cleanup**

Extend the existing cron to mark expired pending rows and delete orphan COS objects only after a grace period. Log upload ID and COS request ID, never signed URLs.

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

Commit message: `feat(media): 迁移资料图片与版本包到 COS`

### Task 6: Secrets, Migration, Dry Run And Production Validation

**Covers:** [S2, S9, S10]

**Files:**
- Modify: `.env.example`
- Modify: `API.md`
- Verify: `wrangler.jsonc`

- [ ] **Step 1: Rotate exposed credentials**

Create a least-privilege Tencent CAM user/key. Set `COS_SECRET_ID` and `COS_SECRET_KEY` with `wrangler secret put`; set non-secret Bucket/Region through Wrangler vars or secrets. Never use the credential pasted in chat.

- [ ] **Step 2: Configure Bucket CORS**

Allow required web origins, methods `PUT,HEAD`, request header `Content-Type`, and expose `ETag,x-cos-request-id`. Android native upload does not depend on CORS.

- [ ] **Step 3: Apply migration and dry-run**

Run `npm test`, `npx wrangler deploy --dry-run`, then apply `0042_cos_uploads.sql` to the confirmed production D1 account.

- [ ] **Step 4: Deploy backend first**

Use `CLOUDFLARE_ACCOUNT_ID=c5a9726ee4c59c70d9261881af33ca87 npx wrangler deploy`. Record Worker version.

- [ ] **Step 5: Production smoke test**

Authorize a tiny image, PUT original/preview directly to COS, complete, create a status, and verify timeline `url`/`preview_url` are COS URLs. Verify legacy multipart still uploads to COS and explicit imgbed fallback works only when requested.

- [ ] **Step 6: Commit docs/config**

Commit message: `docs(media): 记录 COS 直传部署与回退流程`
