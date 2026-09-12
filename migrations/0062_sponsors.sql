-- Standalone/replay-safe sponsor core. Never modifies users.role.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sponsor_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version > 0),
  config_json TEXT NOT NULL CHECK (json_valid(config_json))
);
CREATE TABLE IF NOT EXISTS sponsor_plans (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json))
);
CREATE INDEX IF NOT EXISTS sponsor_plans_enabled ON sponsor_plans(enabled, sort_order, id);
CREATE TABLE IF NOT EXISTS sponsor_memberships (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0, 1)),
  expires_at INTEGER,
  plan_name TEXT,
  color_key TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sponsor_code_batches (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES sponsor_plans(id),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 200),
  source TEXT NOT NULL CHECK (source IN ('admin', 'afdian')),
  actor_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sponsor_codes (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES sponsor_code_batches(id),
  plan_id TEXT NOT NULL REFERENCES sponsor_plans(id),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  code_hash TEXT NOT NULL UNIQUE,
  masked_code TEXT NOT NULL,
  encrypted_code TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  expires_at INTEGER,
  redeemed_at INTEGER,
  redeemed_by INTEGER REFERENCES users(id),
  operation_id TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS sponsor_codes_batch ON sponsor_codes(batch_id, id);
CREATE INDEX IF NOT EXISTS sponsor_codes_filter ON sponsor_codes(plan_id, disabled, redeemed_at, expires_at);
CREATE INDEX IF NOT EXISTS sponsor_codes_redeemer ON sponsor_codes(redeemed_by, redeemed_at);
CREATE TABLE IF NOT EXISTS sponsor_daily_usage (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day_key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  bonus INTEGER NOT NULL DEFAULT 0 CHECK (bonus BETWEEN -100000 AND 100000),
  PRIMARY KEY (user_id, day_key)
);
CREATE TABLE IF NOT EXISTS sponsor_notice_acks (
  user_id INTEGER NOT NULL REFERENCES users(id),
  notice_version INTEGER NOT NULL,
  acknowledged_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, notice_version)
);
CREATE TABLE IF NOT EXISTS sponsor_claims (
  user_id INTEGER NOT NULL REFERENCES users(id),
  benefit_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, benefit_id)
);
CREATE TABLE IF NOT EXISTS sponsor_operations (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  actor_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('redeem','grant','revoke','quota','claim','original','color')),
  request_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  code_id TEXT REFERENCES sponsor_codes(id),
  plan_json TEXT,
  benefit_id TEXT,
  color_key TEXT,
  media_key TEXT,
  notice_version INTEGER,
  adjustment INTEGER,
  day_key TEXT NOT NULL DEFAULT (date('now', '+8 hours')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS sponsor_operations_user_history ON sponsor_operations(user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS sponsor_operations_day ON sponsor_operations(day_key, kind);
CREATE TABLE IF NOT EXISTS sponsor_redemptions (
  id TEXT PRIMARY KEY NOT NULL REFERENCES sponsor_operations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_name TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  expires_at INTEGER,
  permanent INTEGER NOT NULL CHECK (permanent IN (0,1))
);
CREATE INDEX IF NOT EXISTS sponsor_redemptions_user ON sponsor_redemptions(user_id, redeemed_at DESC, id);
CREATE TABLE IF NOT EXISTS sponsor_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS sponsor_audit_recent ON sponsor_audit(created_at DESC, id);
CREATE TABLE IF NOT EXISTS sponsor_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);

INSERT OR IGNORE INTO sponsor_settings(id, version, config_json) VALUES (1, 1, '{"enabled":false,"version":1,"center_title":"赞助者中心","free_daily_limit":3,"sponsor_daily_limit":25,"timezone":"Asia/Shanghai","notice_version":1,"notice_title":"查看原图须知","notice_body":"原图存储与传输会产生运营成本，赞助将帮助分担这些费用。普通用户每天可查看 {x} 张原图，赞助者每天可查看 {y} 张，今日剩余 {a} 张，{reset} 重置。确认继续后扣减本次查看额度，重复查看同一原图也按次计入。","exhausted_title":"今日原图额度已用完","exhausted_body":"普通用户每天可查看 {x} 张原图，将于 {reset} 重置。","sponsor_exhausted_body":"赞助者每天可查看 {y} 张原图，将于 {reset} 重置。","purchase_title":"赞助须知","purchase_steps":["请选择适合自己的赞助方案，理性赞助。","前往爱发电完成支付后，获取兑换码并返回赞助者中心兑换。","从购买页面返回不代表支付或兑换成功，请以赞助者中心显示为准。"],"minimum_read_seconds":5,"default_color_key":"blue","colors":[{"key":"blue","name":"宝宝蓝","light":"#4E7394","dark":"#B9D9F0","permanent_only":false},{"key":"pink","name":"宝宝粉","light":"#A15E7C","dark":"#F2BED4","permanent_only":false},{"key":"gold","name":"金色","light":"#795500","dark":"#F6D778","permanent_only":true}],"benefits":[{"id":"original","title":"更多原图额度","description":"身份有效期间自动提升每日原图额度。","status":"automatic","action":"original","sort_order":10},{"id":"color","title":"用户名颜色","description":"普通赞助者可选择宝宝蓝或宝宝粉，永久赞助者使用专属金色。","status":"available","action":"color","sort_order":20},{"id":"lottery","title":"赞助者抽奖","description":"敬请期待，当前尚未开放。","status":"coming_soon","action":"none","sort_order":30},{"id":"more","title":"更多权益","description":"更多赞助者权益正在筹备。","status":"coming_soon","action":"none","sort_order":40}]}');

-- Prices, durations and purchase mappings exist only in this backend seed.
INSERT OR IGNORE INTO sponsor_plans(id,version,enabled,sort_order,plan_json)
SELECT id,1,1,sort_order,json_object('id',id,'version',1,'name',name,'description',description,'price_minor',price,'currency','CNY','duration_unit',unit,'duration_count',duration,'purchase_url',
'https://ifdian.net/order/create?product_type=1&plan_id=6d5249c2adcf11f1b96d52540025c377&sku=%5B%7B%22sku_id%22%3A%22'||sku||'%22,%22count%22%3A1%7D%5D&viokrz_ex=0',
'afdian_plan_id','6d5249c2adcf11f1b96d52540025c377','afdian_sku_id',sku,'enabled',json('true'),'sort_order',sort_order)
FROM (
  SELECT 'week' id,'周赞助者' name,'7 天赞助者身份' description,190 price,'day' unit,7 duration,10 sort_order,'6d5b2998adcf11f1982752540025c377' sku
  UNION ALL SELECT 'month','月赞助者','1 个自然月赞助者身份',590,'month',1,20,'6d62f682adcf11f1b25152540025c377'
  UNION ALL SELECT 'quarter','季赞助者','3 个自然月赞助者身份',1490,'month',3,30,'6d6ae388adcf11f18ab552540025c377'
  UNION ALL SELECT 'year','年赞助者','12 个自然月赞助者身份',4990,'month',12,40,'6d72faf0adcf11f186ae52540025c377'
  UNION ALL SELECT 'permanent','永久赞助者','永久赞助者身份',9900,'permanent',0,50,'6d7a8dd8adcf11f18eea52540025c377'
);

-- The view is evaluated inside mutation transactions, including the response snapshot.
-- Refresh derived rules on replay without overwriting settings, memberships or history.
DROP VIEW IF EXISTS sponsor_me_json;
DROP VIEW IF EXISTS sponsor_user_state;
CREATE VIEW sponsor_user_state AS
SELECT u.id AS user_id,
  CASE WHEN m.permanent=1 OR m.expires_at>unixepoch() THEN 1 ELSE 0 END AS active,
  COALESCE(m.permanent,0) AS permanent, m.expires_at, m.plan_name,
  CASE WHEN m.permanent=1 THEN
    (SELECT json_extract(value,'$.key') FROM json_each(s.config_json,'$.colors') WHERE json_extract(value,'$.permanent_only')=1 ORDER BY CAST(key AS INTEGER) LIMIT 1)
    WHEN m.expires_at>unixepoch() THEN COALESCE(
      (SELECT json_extract(value,'$.key') FROM json_each(s.config_json,'$.colors') WHERE json_extract(value,'$.key')=m.color_key AND json_extract(value,'$.permanent_only')=0),
      json_extract(s.config_json,'$.default_color_key')) END AS color_key,
  s.config_json, s.version AS config_version,
  date('now','+8 hours') AS day_key,
  unixepoch(date('now','+8 hours','+1 day'),'-8 hours') AS resets_at,
  COALESCE(d.used,0) AS used,
  MAX(0,CASE WHEN m.permanent=1 OR m.expires_at>unixepoch() THEN json_extract(s.config_json,'$.sponsor_daily_limit') ELSE json_extract(s.config_json,'$.free_daily_limit') END+COALESCE(d.bonus,0)) AS quota_limit
FROM users u CROSS JOIN sponsor_settings s
LEFT JOIN sponsor_memberships m ON m.user_id=u.id
LEFT JOIN sponsor_daily_usage d ON d.user_id=u.id AND d.day_key=date('now','+8 hours')
WHERE s.id=1;
CREATE VIEW IF NOT EXISTS sponsor_me_json AS
SELECT v.user_id, json_object(
  'sponsor',json_object('active',json(CASE WHEN active=1 THEN 'true' ELSE 'false' END),'permanent',json(CASE WHEN permanent=1 THEN 'true' ELSE 'false' END),
  'expires_at',CASE WHEN permanent=1 THEN NULL ELSE expires_at END,'plan_name',plan_name,
  'color_key',(SELECT json_extract(value,'$.key') FROM json_each(config_json,'$.colors') WHERE json_extract(value,'$.key')=color_key AND active=1 AND (permanent=1 OR json_extract(value,'$.permanent_only')=0)),
  'color_light',(SELECT json_extract(value,'$.light') FROM json_each(config_json,'$.colors') WHERE json_extract(value,'$.key')=color_key AND active=1 AND (permanent=1 OR json_extract(value,'$.permanent_only')=0)),
  'color_dark',(SELECT json_extract(value,'$.dark') FROM json_each(config_json,'$.colors') WHERE json_extract(value,'$.key')=color_key AND active=1 AND (permanent=1 OR json_extract(value,'$.permanent_only')=0))),
  'quota',json_object('limit',quota_limit,'used',used,'remaining',MAX(0,quota_limit-used),'resets_at',resets_at,'day_key',day_key),
  'notice_required',json(CASE WHEN active=0 AND NOT EXISTS(SELECT 1 FROM sponsor_notice_acks a WHERE a.user_id=v.user_id AND a.notice_version=json_extract(config_json,'$.notice_version')) THEN 'true' ELSE 'false' END),
  'config_version',config_version,
  'claimed_benefit_ids',json((SELECT json_group_array(benefit_id) FROM (SELECT benefit_id FROM sponsor_claims WHERE user_id=v.user_id ORDER BY benefit_id)))
) AS result_json FROM sponsor_user_state v;

DROP TRIGGER IF EXISTS sponsor_operation_validate;
CREATE TRIGGER sponsor_operation_validate BEFORE INSERT ON sponsor_operations
WHEN NOT EXISTS (SELECT 1 FROM sponsor_operations WHERE id=NEW.id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sponsor_settings WHERE id=1) THEN RAISE(ABORT,'sponsors_unavailable') END;
  SELECT CASE WHEN NEW.kind NOT IN ('revoke','quota') AND (SELECT json_extract(config_json,'$.enabled') FROM sponsor_settings WHERE id=1)!=1 THEN RAISE(ABORT,'sponsors_disabled') END;
  SELECT CASE WHEN NEW.day_key!=date('now','+8 hours') OR ABS(NEW.created_at-unixepoch())>60 THEN RAISE(ABORT,'operation_expired') END;
  SELECT CASE WHEN NEW.kind IN ('redeem','grant') AND EXISTS(SELECT 1 FROM sponsor_memberships WHERE user_id=NEW.user_id AND permanent=1) THEN RAISE(ABORT,'already_permanent') END;
  SELECT CASE WHEN NEW.kind='redeem' AND NOT EXISTS(SELECT 1 FROM sponsor_codes WHERE id=NEW.code_id AND disabled=0 AND redeemed_at IS NULL AND (expires_at IS NULL OR expires_at>unixepoch()) AND snapshot_json=NEW.plan_json) THEN RAISE(ABORT,'code_unavailable') END;
  SELECT CASE WHEN NEW.kind='grant' AND NOT EXISTS(SELECT 1 FROM sponsor_plans WHERE id=json_extract(NEW.plan_json,'$.id') AND enabled=1 AND plan_json=NEW.plan_json) THEN RAISE(ABORT,'plan_changed') END;
  SELECT CASE WHEN NEW.kind IN ('color','claim') AND NOT EXISTS(SELECT 1 FROM sponsor_user_state WHERE user_id=NEW.user_id AND active=1) THEN RAISE(ABORT,'sponsor_required') END;
  SELECT CASE WHEN NEW.kind='color' AND NOT EXISTS(SELECT 1 FROM sponsor_user_state v,json_each(v.config_json,'$.colors') c WHERE user_id=NEW.user_id AND json_extract(c.value,'$.key')=NEW.color_key AND json_extract(c.value,'$.permanent_only')=permanent AND (permanent=0 OR NEW.color_key=v.color_key)) THEN RAISE(ABORT,'invalid_color') END;
  SELECT CASE WHEN NEW.kind='claim' AND NOT EXISTS(SELECT 1 FROM sponsor_settings s,json_each(s.config_json,'$.benefits') b WHERE json_extract(b.value,'$.id')=NEW.benefit_id AND json_extract(b.value,'$.status')='available' AND json_extract(b.value,'$.action')='claim') THEN RAISE(ABORT,'benefit_unavailable') END;
  SELECT CASE WHEN NEW.kind='original' AND EXISTS(SELECT 1 FROM sponsor_user_state v WHERE user_id=NEW.user_id AND active=0 AND NOT EXISTS(SELECT 1 FROM sponsor_notice_acks a WHERE a.user_id=NEW.user_id AND a.notice_version=json_extract(v.config_json,'$.notice_version')) AND (NEW.notice_version IS NULL OR NEW.notice_version!=json_extract(v.config_json,'$.notice_version'))) THEN RAISE(ABORT,'notice_required') END;
  SELECT CASE WHEN NEW.kind='original' AND EXISTS(SELECT 1 FROM sponsor_user_state WHERE user_id=NEW.user_id AND used>=quota_limit) THEN RAISE(ABORT,'quota_exhausted') END;
  SELECT CASE WHEN NEW.kind='quota' AND (NEW.adjustment IS NULL OR ABS(NEW.adjustment)>100000 OR ABS(COALESCE((SELECT bonus FROM sponsor_daily_usage WHERE user_id=NEW.user_id AND day_key=NEW.day_key),0)+NEW.adjustment)>100000) THEN RAISE(ABORT,'invalid_adjustment') END;
END;

CREATE TRIGGER IF NOT EXISTS sponsor_operation_apply AFTER INSERT ON sponsor_operations
BEGIN
  INSERT INTO sponsor_memberships(user_id) VALUES(NEW.user_id) ON CONFLICT(user_id) DO NOTHING;
  -- Read the latest expiry under SQLite's write transaction. Calendar months clamp to
  -- the target month's last day in Asia/Shanghai, retaining the time of day.
  UPDATE sponsor_memberships SET
    expires_at=CASE WHEN json_extract(NEW.plan_json,'$.duration_unit')='permanent' THEN NULL ELSE (
      WITH base AS (SELECT MAX(COALESCE(expires_at,0),NEW.created_at) AS ts),
      duration AS (SELECT json_extract(NEW.plan_json,'$.duration_count') AS n),
      target AS (SELECT datetime(ts,'unixepoch','+8 hours') AS local, date(ts,'unixepoch','+8 hours','start of month','+'||n||' months') AS month_start FROM base,duration)
      SELECT CASE WHEN json_extract(NEW.plan_json,'$.duration_unit')='day' THEN ts+n*86400 ELSE
        unixepoch(month_start,'+'||(MIN(CAST(strftime('%d',local) AS INTEGER),CAST(strftime('%d',month_start,'+1 month','-1 day') AS INTEGER))-1)||' days',strftime('%H hours',local),strftime('%M minutes',local),strftime('%S seconds',local),'-8 hours') END
      FROM base,duration,target
    ) END,
    permanent=CASE WHEN json_extract(NEW.plan_json,'$.duration_unit')='permanent' THEN 1 ELSE 0 END,
    plan_name=json_extract(NEW.plan_json,'$.name'),updated_at=NEW.created_at
    WHERE user_id=NEW.user_id AND NEW.kind IN ('redeem','grant');
  UPDATE sponsor_codes SET redeemed_at=NEW.created_at,redeemed_by=NEW.user_id,operation_id=NEW.id WHERE id=NEW.code_id AND NEW.kind='redeem';
  INSERT INTO sponsor_redemptions(id,user_id,plan_name,redeemed_at,expires_at,permanent)
    SELECT NEW.id,user_id,plan_name,NEW.created_at,expires_at,permanent FROM sponsor_memberships WHERE user_id=NEW.user_id AND NEW.kind IN ('redeem','grant');
  UPDATE sponsor_memberships SET permanent=0,expires_at=NULL,plan_name=NULL,color_key=NULL,updated_at=NEW.created_at WHERE user_id=NEW.user_id AND NEW.kind='revoke';
  UPDATE sponsor_memberships SET color_key=NEW.color_key,updated_at=NEW.created_at WHERE user_id=NEW.user_id AND NEW.kind='color';
  INSERT INTO sponsor_claims(user_id,benefit_id,operation_id) SELECT NEW.user_id,NEW.benefit_id,NEW.id WHERE NEW.kind='claim' ON CONFLICT(user_id,benefit_id) DO NOTHING;
  INSERT INTO sponsor_daily_usage(user_id,day_key,used,bonus)
    SELECT NEW.user_id,NEW.day_key,
      CASE WHEN NEW.kind='original' THEN 1 ELSE 0 END,
      CASE WHEN NEW.kind='quota' THEN COALESCE(NEW.adjustment,0) ELSE 0 END
    WHERE NEW.kind IN ('original','quota')
    ON CONFLICT(user_id,day_key) DO UPDATE SET used=used+excluded.used,bonus=bonus+excluded.bonus;
  INSERT INTO sponsor_notice_acks(user_id,notice_version)
    SELECT NEW.user_id,json_extract(config_json,'$.notice_version') FROM sponsor_user_state WHERE user_id=NEW.user_id AND active=0 AND NEW.kind='original'
    ON CONFLICT(user_id,notice_version) DO NOTHING;
  INSERT INTO sponsor_audit(id,actor_id,user_id,action,reason) VALUES(NEW.id,NEW.actor_id,CAST(NEW.user_id AS TEXT),NEW.kind,NEW.reason);
  UPDATE sponsor_operations SET result_json=(SELECT result_json FROM sponsor_me_json WHERE user_id=NEW.user_id) WHERE id=NEW.id;
END;
