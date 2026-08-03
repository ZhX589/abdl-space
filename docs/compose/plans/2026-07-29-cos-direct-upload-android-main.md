# Android 2.4.0 COS Direct Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a minimal 2.4.0 production patch from the 2.3.0 main baseline that uploads images and APK-related media directly to COS with explicit user-confirmed imgbed fallback.

**Architecture:** Build in an isolated worktree from `main`. Replace `UploadAttachment` with authorize/direct-PUT/complete orchestration while preserving the existing Compose screen callbacks and Mastodon Attachment contract. Generate a 540px preview locally and upload original plus preview sequentially with aggregate progress.

**Tech Stack:** Java 17/21 Android, OkHttp, existing `ResizedImageRequestBody`, Gson, AppKit API callbacks.

---

### Task 1: Create Main Patch Worktree And Version 2.4.0

**Covers:** [S8, S10]

**Files:**
- Modify: `mastodon/build.gradle:18-24`

- [ ] Create an isolated branch from `main` named `hotfix/2.4.0-cos-upload`; confirm it starts at tag `v2.3.0`/commit `bee37276` and has no develop UI changes.
- [ ] Add a version test/assertion or inspect generated BuildConfig, then bump `versionCode` from the 2.3.0 value to the next integer and `versionName` to `2.4.0`.
- [ ] Build baseline release before feature edits and record any pre-existing warnings.
- [ ] Commit: `chore(release): 准备 2.4.0 COS 上传补丁`.

### Task 2: Upload Protocol Models And Requests

**Covers:** [S3, S4, S6, S7]

**Files:**
- Create: `mastodon/src/main/java/org/joinmastodon/android/model/CosUploadAuthorization.java`
- Create: `mastodon/src/main/java/org/joinmastodon/android/api/requests/statuses/AuthorizeMediaUpload.java`
- Create: `mastodon/src/main/java/org/joinmastodon/android/api/requests/statuses/CompleteMediaUpload.java`
- Create: `mastodon/src/main/java/org/joinmastodon/android/api/CosPutRequest.java`

- [ ] Write failing JVM tests for authorization JSON parsing, mandatory signed headers, aggregate progress, cancellation, and COS PUT error mapping.
- [ ] Run the focused tests and confirm RED.
- [ ] Implement authorize/complete Mastodon requests and a direct absolute-URL OkHttp PUT using the shared `MastodonAPIController.getHttpClient()`; never create a per-upload client.
- [ ] Ensure signed PUT sends exactly the headers returned by backend and does not add Authorization bearer tokens to COS.
- [ ] Run tests GREEN and commit: `feat(media): 添加 COS 直传协议客户端`.

### Task 3: Original And 540px Preview Upload Orchestration

**Covers:** [S4, S6, S10]

**Files:**
- Modify: `mastodon/src/main/java/org/joinmastodon/android/api/requests/statuses/UploadAttachment.java`
- Reuse: `mastodon/src/main/java/org/joinmastodon/android/api/ResizedImageRequestBody.java`
- Create: `mastodon/src/main/java/org/joinmastodon/android/api/CosMediaUpload.java`

- [ ] Write failing tests for image flow: authorize original/preview, upload both, complete original with preview upload ID, return Attachment; non-image flow uploads one object; cancellation stops current PUT and prevents completion.
- [ ] Run tests RED.
- [ ] Implement local preview longest edge 540px without upscaling and orientation correction. Preserve transparency as WebP; encode opaque previews as JPEG quality 78.
- [ ] Aggregate progress by total bytes across original and preview so existing UI still receives monotonic 0-100% callbacks.
- [ ] Run tests GREEN and commit: `feat(media): 直传 COS 原图与 540px 缩略图`.

### Task 4: Explicit User-Confirmed Imgbed Fallback

**Covers:** [S6, S9, S10]

**Files:**
- Modify: `mastodon/src/main/java/org/joinmastodon/android/ui/viewcontrollers/ComposeMediaViewController.java:366-449`
- Create: `mastodon/src/main/java/org/joinmastodon/android/api/requests/statuses/UploadAttachmentFallback.java`
- Modify: `mastodon/src/main/res/values-zh-rCN/strings.xml`

- [ ] Write failing state tests for COS failure actions: retry stays on COS; fallback is never automatic; confirmed fallback invokes legacy multipart with explicit fallback header; cancellation invokes neither.
- [ ] Run tests RED.
- [ ] Replace the single retry action with a dialog offering “重试 COS” and “使用备用上传”. The confirmation text must state slower upload/access, third-party dependency, and possible realtime thumbnail generation.
- [ ] Implement fallback request by reusing the old multipart body and adding the backend-recognized explicit fallback header/field.
- [ ] Run tests GREEN and commit: `feat(media): 添加用户确认的图床备用上传`.

### Task 5: Profile Images And Release Build Verification

**Covers:** [S5, S8, S10]

**Files:**
- Modify the main-branch profile upload request call sites discovered by grep for multipart avatar/header.
- Modify: `mastodon/src/main/res/values-zh-rCN/strings.xml`

- [ ] Route avatar/header through the shared COS image uploader and submit completed COS URL to profile update. Use the same explicit fallback dialog on failure.
- [ ] Run focused tests, `git diff --check`, and full `:mastodon:assembleRelease`.
- [ ] Commit after successful build: `feat(media): 完成 2.4.0 COS 上传补丁`.
- [ ] Install/test release: post image original/preview, retry COS, confirmed fallback, avatar/header, cancellation, and old timeline images.
- [ ] Do not merge to `main` until the user explicitly approves the tested Release APK.
