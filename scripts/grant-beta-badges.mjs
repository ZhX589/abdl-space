import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BETA_BADGE_KEY = 'beta';
export const BETA_COUNTS_SQL = `SELECT COUNT(*) AS eligible_count,
  COALESCE(SUM(EXISTS(SELECT 1 FROM user_badges ub WHERE ub.user_id = u.id AND ub.badge_key = ?)), 0) AS already_owned_count,
  COALESCE(SUM(NOT EXISTS(SELECT 1 FROM user_badges ub WHERE ub.user_id = u.id AND ub.badge_key = ?)), 0) AS missing_count
FROM users u WHERE u.is_beta_user = 1`;
export const GRANT_BETA_SQL = `INSERT INTO user_badges (user_id, badge_key, unlocked_at, displayed, acknowledged_at)
SELECT u.id, b.key, CURRENT_TIMESTAMP, 0, NULL
FROM users u JOIN badges b ON b.key = ?
WHERE u.is_beta_user = 1
  AND NOT EXISTS(SELECT 1 FROM user_badges ub WHERE ub.user_id = u.id AND ub.badge_key = b.key)
ON CONFLICT(user_id, badge_key) DO NOTHING`;

/** 只读取徽章定义和创始资格汇总，不导出用户资料。 */
export async function inspectBetaBadges(query) {
  const definition = await query('SELECT key, name FROM badges WHERE key = ?', [BETA_BADGE_KEY]);
  if (definition.results.length !== 1) throw new Error('beta 徽章定义不存在，未发放任何徽章');
  const counts = await query(BETA_COUNTS_SQL, [BETA_BADGE_KEY, BETA_BADGE_KEY]);
  const row = counts.results[0];
  if (!row || !['eligible_count', 'already_owned_count', 'missing_count'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
    || row.eligible_count !== row.already_owned_count + row.missing_count) {
    throw new Error('创始用户徽章统计不完整，停止发放');
  }
  return { badge: definition.results[0], ...row };
}

/** 幂等补发缺失徽章；不覆盖已有持有、确认或佩戴状态。 */
export async function grantBetaBadges(query) {
  const before = await inspectBetaBadges(query);
  const result = await query(GRANT_BETA_SQL, [BETA_BADGE_KEY]);
  const after = await inspectBetaBadges(query);
  if (after.missing_count !== 0) throw new Error('发放后仍有缺失徽章，请重新核验');
  return { before, inserted_count: result.meta?.changes ?? null, after };
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some(flag => !['--apply', '--dry-run'].includes(flag)) || (flags.includes('--apply') && flags.includes('--dry-run'))) {
    throw new Error('用法：node scripts/grant-beta-badges.mjs [--dry-run|--apply]；默认只读');
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f\d]{32}$/.test(account)) throw new Error('必须显式设置 CLOUDFLARE_ACCOUNT_ID');
  const config = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const database = /"database_id"\s*:\s*"([a-f\d-]{36})"/.exec(config)?.[1];
  if (!database) throw new Error('无法识别项目 D1 database_id');
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const legacyRoot = join(homedir(), '.wrangler');
    const legacyExists = await stat(legacyRoot).then(value => value.isDirectory(), () => false);
    const authRoot = legacyExists ? legacyRoot : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), '.wrangler');
    const auth = await readFile(join(authRoot, 'config/default.toml'), 'utf8');
    const expiration = /^expiration_time\s*=\s*"([^"]+)"/m.exec(auth)?.[1];
    if (!expiration || !Number.isFinite(Date.parse(expiration)) || Date.parse(expiration) <= Date.now()) {
      throw new Error('Wrangler OAuth 已过期，请先使用 Wrangler 刷新登录');
    }
    token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(auth)?.[1];
  }
  if (!token) throw new Error('Cloudflare 认证不可用');
  const query = async (sql, params) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    const result = data.result?.[0];
    if (!response.ok || data.success !== true || result?.success !== true || !Array.isArray(result.results)) {
      throw new Error(`D1 查询未成功（HTTP ${response.status}）；未自动重试写入，请重新运行只读预检`);
    }
    return result;
  };
  const summary = flags.includes('--apply') ? await grantBetaBadges(query) : await inspectBetaBadges(query);
  console.log(JSON.stringify({ mode: flags.includes('--apply') ? 'apply' : 'dry-run', ...summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
