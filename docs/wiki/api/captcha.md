# Captcha 验证码

人机验证系统，防机器人注册/刷接口。使用量子安全级别（Quantum-verify）的 challenge-response 协议。

---

## 工作原理

```
1. 前端调用 POST /api/captcha/challenge 获取挑战
2. 前端在客户端完成计算（embed SDK 自动处理）
3. 前端将计算结果作为 X-Captcha-Token header 发送到受保护接口
4. 后端验证 token 是否有效
```

---

## POST /api/v1/captcha/challenge

获取验证挑战。公开 v1 接口，供 captcha embed SDK 使用。

- **鉴权**：无需（但需 CAPTCHA API Key）

**请求头：**

```
X-Captcha-Key: <captcha_api_key>
```

**请求示例：**

```bash
curl -X POST https://api.abdl-space.top/api/v1/captcha/challenge \
  -H "X-Captcha-Key: YOUR_CAPTCHA_KEY" \
  -H "Content-Type: application/json"
```

**响应 200：**

```json
{
  "challenge_id": "c_abc123",
  "challenge": {
    "type": "quantum-verify",
    "data": { "a": 1234, "b": 5678, "op": "+" }
  }
}
```

---

## POST /api/v1/captcha/verify

提交计算答案获取 token。

```bash
curl -X POST https://api.abdl-space.top/api/v1/captcha/verify \
  -H "X-Captcha-Key: YOUR_CAPTCHA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"challenge_id": "c_abc123", "answer": 6912}'
```

**响应 200：**

```json
{
  "token": "capt_eyJhbGci...",
  "expires_at": "2026-05-20T10:35:00.000Z"
}
```

---

## POST /api/captcha/challenge

管理端 captcha API。（管理员用）

---

## 使用 Captcha Token

在需要人机验证的接口中，携带 `X-Captcha-Token` 头：

```bash
curl -X POST https://api.abdl-space.top/api/auth/register \
  -H "Content-Type: application/json" \
  -H "X-Captcha-Token: capt_eyJhbGci..." \
  -d '{"email":"...", "password":"...", "username":"..."}'
```

---

## Captcha Embed SDK

前端集成使用 embed SDK（`embed.js`），无需手动处理 challenge 流程：

```html
<script src="https://api.abdl-space.top/static/embed.js"></script>
<script>
  const captcha = new ABDLCaptcha({
    apiKey: 'YOUR_CAPTCHA_KEY',
    apiBase: 'https://api.abdl-space.top'
  });
  
  const token = await captcha.getToken();
  // 将 token 作为 X-Captcha-Token 发送
</script>
```

---

## Captcha API Key 管理

管理员接口 `GET/POST/DELETE /api/captcha/keys`。

```bash
# 创建 captcha key
curl -X POST https://api.abdl-space.top/api/captcha/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "Production Frontend", "domain": "abdl-space.top"}'
```
