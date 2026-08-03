# Android Develop COS Direct Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the verified COS direct-upload client to the Android develop line without disturbing its current 3.0.0 UI and feature work.

**Architecture:** Work from a clean develop worktree after the shared Android upload client is validated on the 2.4.0 patch. Cherry-pick only upload-focused commits or reproduce the same focused files, resolving API/UI differences without importing main branch history.

**Tech Stack:** Java Android, OkHttp, existing Compose/AppKit media UI, Gradle debug build.

---

### Task 1: Create Clean Develop Worktree

**Covers:** [S8]

**Files:**
- Verify branch state only.

- [ ] Create `feat/cos-direct-upload-develop` from committed `develop`, not the dirty primary checkout.
- [ ] Confirm the worktree contains current develop media retry behavior and no uncommitted primary-worktree changes.
- [ ] Run focused existing media tests and a debug baseline build.

### Task 2: Port Shared COS Upload Client

**Covers:** [S3, S4, S6, S7]

**Files:**
- Port the authorization models/requests, `CosPutRequest`, `CosMediaUpload`, and `UploadAttachment` integration from the approved 2.4.0 patch.
- Modify current develop `ComposeMediaViewController.java` without removing its bounded failed-image retry changes.

- [ ] Cherry-pick only upload-client commits where clean; otherwise apply equivalent focused patches.
- [ ] Run the same protocol/orchestration tests as main and confirm original + 540px preview direct PUT, cancellation, and aggregate progress.
- [ ] Resolve develop-specific model/API differences while keeping backend JSON identical.
- [ ] Commit: `feat(media): 在开发版接入 COS 直传`.

### Task 3: Port Manual Imgbed Fallback And Profile Uploads

**Covers:** [S5, S6, S9]

**Files:**
- Modify current develop media error UI and profile avatar/header upload call sites.
- Modify Chinese strings.

- [ ] Add the same two-choice COS failure dialog and warning text; verify no automatic fallback.
- [ ] Preserve current develop upload error URL diagnostics and media retry behavior.
- [ ] Route avatar/header through COS complete URLs.
- [ ] Run focused tests and commit: `feat(media): 为开发版添加备用上传选择`.

### Task 4: Debug Build And Verification

**Covers:** [S8, S10]

**Files:**
- Verify: `mastodon/build/outputs/apk/debug/mastodon-debug.apk`

- [ ] Run `git diff --check` and all COS upload tests.
- [ ] Run `JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew :mastodon:assembleDebug -x checkDebugAarMetadata -x checkDebugDuplicateClasses --no-daemon`.
- [ ] Commit after successful build if any plan-related changes remain.
- [ ] Install Debug and verify direct COS original/preview upload, manual fallback, avatar/header, cancellation, and compatibility with existing liquid navigation/media display.
- [ ] Keep the branch separate until the 2.4.0 release path is user-approved.
