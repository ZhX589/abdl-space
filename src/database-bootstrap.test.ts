import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { databaseBootstrapFiles } from '../scripts/database-bootstrap-files.mjs'

test('new database bootstrap creates every current feature dependency', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    for (const file of databaseBootstrapFiles) {
      db.exec(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    }
    for (const name of [
      'badges', 'user_badges', 'sponsor_settings', 'sponsor_user_state',
      'novel_v2_workspaces', 'novel_v2_releases', 'baby_verification_settings',
      'baby_verification_applications', 'baby_verification_certificates',
    ]) {
      assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), `missing ${name}`)
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pragma_foreign_key_check').get()?.count, 0)
  } finally {
    db.close()
  }
})
