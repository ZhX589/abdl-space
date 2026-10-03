# 管理端QQ修复：既有全量测试失败证据

```text
Final: 349 pass / 10 fail; baseline: 341 pass / 10 fail. Failure names unchanged.

✖ failing tests:

test at src/database-bootstrap.test.ts:7:1
✖ new database bootstrap creates every current feature dependency (501.366288ms)
  Error: no such column: "paper_color"
      at TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/database-bootstrap.test.ts:12:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    code: 'ERR_SQLITE_ERROR',
    errcode: 1,
    errstr: 'SQL logic error'
  }

test at src/middleware/app-clients.test.ts:137:1
✖ concurrent duplicate requests shared IP upgrades downgrades exact pairs and last-observed latest distribution (83.482979ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  0 !== 1

      at TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/middleware/app-clients.test.ts:149:12)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at src/routes/admin-identities.test.ts:1:1
✖ src/routes/admin-identities.test.ts (783.540551ms)
  'test failed'

test at src/routes/qq.test.ts:143:1
✖ exchange rejects banned bound users without issuing a token (78.262012ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  200 !== 403

      at TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/routes/qq.test.ts:152:12)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 200,
    expected: 403,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at src/routes/qq.test.ts:213:1
✖ delete treats passkey lookup failures as unavailable instead of allowing unsafe unbind (143.377737ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  502 !== 503

      at TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/routes/qq.test.ts:222:12)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 502,
    expected: 503,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at src/routes/qq.test.ts:228:1
✖ delete protects the sole login method and is otherwise idempotent (70.476534ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  502 !== 409

      at TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/routes/qq.test.ts:235:12)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 502,
    expected: 409,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at src/routes/qq.test.ts:247:1
✖ database guards serialize QQ and last-passkey deletion without locking out the user (82.045336ms)
  Error: no such column: nbw_uid
      at TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/routes/qq.test.ts:255:17)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    code: 'ERR_SQLITE_ERROR',
    errcode: 1,
    errstr: 'SQL logic error'
  }

test at src/routes/uploads.test.ts:367:1
✖ complete accepts an expired completed preview when the original is still pending (32.389154ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 1

      at withHead (file:///home/ZYongX/projects/abdl-space/src/routes/uploads.test.ts:200:9)
      at async TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/routes/uploads.test.ts:371:2)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at src/routes/uploads.test.ts:376:1
✖ complete verifies preview then atomically links it when completing an original (29.996059ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 1

      at withHead (file:///home/ZYongX/projects/abdl-space/src/routes/uploads.test.ts:200:9)
      at async TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/routes/uploads.test.ts:380:2)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at src/routes/uploads.test.ts:467:1
✖ complete returns the preview key and URL copied by the atomic update (9.890856ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 1

      at withHead (file:///home/ZYongX/projects/abdl-space/src/routes/uploads.test.ts:200:9)
      at async TestContext.<anonymous> (file:///home/ZYongX/projects/abdl-space/src/routes/uploads.test.ts:476:2)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

```
