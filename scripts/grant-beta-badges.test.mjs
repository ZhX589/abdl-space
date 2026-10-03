import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { grantBetaBadges, inspectBetaBadges } from './grant-beta-badges.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY, is_beta_user INTEGER NOT NULL DEFAULT 0);`);
  const migration = readFileSync(new URL('../migrations/0025_account_system_upgrade.sql', import.meta.url), 'utf8');
  db.exec(migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS badges'), migration.indexOf('-- 3. 补充索引')));
  db.exec(readFileSync(new URL('../migrations/0058_badge_colors_notification.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO users(id,is_beta_user) VALUES(1,1),(2,1),(3,0),(4,0),(5,1);
    INSERT INTO badges(key,name,icon,description,condition_type,condition_value) VALUES
      ('beta','创始成员','star','beta','manual',0),('other','其他','star','other','manual',0);
    INSERT INTO user_badges(user_id,badge_key,unlocked_at,displayed,acknowledged_at) VALUES
      (1,'beta','2026-01-01',1,'2026-01-02'),(2,'other','2026-01-03',1,'2026-01-04'),
      (4,'beta','2026-01-05',0,'2026-01-06');`);
  const query = async (sql, params) => {
    const statement = db.prepare(sql);
    if (sql.startsWith('INSERT')) return { results: [], meta: { changes: Number(statement.run(...params).changes) } };
    return { results: statement.all(...params).map(row => ({ ...row })), meta: {} };
  };
  return { db, query };
}

test('补发只覆盖创始用户缺失徽章，已有状态与其他佩戴徽章完全不变，重复执行零新增', async () => {
  const { db, query } = fixture();
  try {
    const existing = db.prepare('SELECT * FROM user_badges ORDER BY id').all();
    const first = await grantBetaBadges(query);
    assert.deepEqual(first.before, { badge: { key: 'beta', name: '创始成员' }, eligible_count: 3, already_owned_count: 1, missing_count: 2 });
    assert.equal(first.inserted_count, 2);
    assert.equal(first.after.missing_count, 0);
    assert.deepEqual(db.prepare('SELECT * FROM user_badges WHERE id <= 3 ORDER BY id').all(), existing);
    for (const id of [2, 5]) {
      const badge = db.prepare('SELECT * FROM user_badges WHERE user_id = ? AND badge_key = ?').get(id, 'beta');
      assert.equal(badge.displayed, 0);
      assert.equal(badge.acknowledged_at, null);
      assert.ok(badge.unlocked_at);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_badges WHERE user_id = ?').get(3).n, 0);
    const second = await grantBetaBadges(query);
    assert.equal(second.inserted_count, 0);
    assert.equal(second.after.already_owned_count, 3);
  } finally { db.close(); }
});

test('缺少用户已创建的 beta 定义时不补建、不发放孤立持有记录', async () => {
  const { db, query } = fixture();
  try {
    db.prepare('DELETE FROM badges WHERE key = ?').run('beta');
    const before = db.prepare('SELECT * FROM user_badges ORDER BY id').all();
    await assert.rejects(() => grantBetaBadges(query), /定义不存在/);
    assert.deepEqual(db.prepare('SELECT * FROM user_badges ORDER BY id').all(), before);
  } finally { db.close(); }
});

test('统计异常、数据库失败或发放后残缺不报告成功', async () => {
  const { db, query } = fixture();
  try {
    await assert.rejects(() => inspectBetaBadges(async (sql, params) => sql.includes('eligible_count') ? { results: [{ eligible_count: 3, already_owned_count: 0, missing_count: 2 }] } : query(sql, params)), /统计不完整/);
    await assert.rejects(() => grantBetaBadges(async () => { throw new Error('unavailable'); }), /unavailable/);
    await assert.rejects(() => grantBetaBadges(async (sql, params) => sql.startsWith('INSERT') ? { results: [], meta: { changes: 0 } } : query(sql, params)), /仍有缺失/);
  } finally { db.close(); }
});
