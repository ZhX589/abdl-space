# OAuth 2.0

OAuth 2.0 授权码流程（Authorization Code Grant），支持 PKCE。用于第三方应用接入。

---

## 流程概览

```
1. 应用重定向用户到 /api/oauth/authorize
2. 用户登录并授权
3. 回调重定向，携带 authorization_code
4. 应用用 code 换取 access_token
5. 使用 access_token 调用 API
```

---

## POST /api/oauth/authorize

授权端点。重定向用户到登录/授权页。

**Query 参数：**

| 参数 | 类型 | 说明 |
|:---|:---|:---|
| `client_id` | string | OAuth 客户端 ID |
| `redirect_uri` | string | 回调地址 |
| `response_type` | string | 固定 `code` |
| `state` | string | 防 CSRF 随机字符串 |
| `code_challenge` | string | PKCE code challenge（推荐） |
| `code_challenge_method` | string | `S256` |

```
GET /api/oauth/authorize?client_id=xxx&redirect_uri=https://app.example.com/callback&response_type=code&state=random123&code_challenge=xxx&code_challenge_method=S256
```

---

## POST /api/oauth/token

用 authorization code 换取 access token。

- **鉴权**：无（需 client secret）

**请求体：**

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `grant_type` | string | `authorization_code` |
| `code` | string | 授权码 |
| `client_id` | string | |
| `client_secret` | string | |
| `redirect_uri` | string | |
| `code_verifier` | string | PKCE code verifier |

```bash
curl -X POST https://api.abdl-space.top/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "abc123...",
    "client_id": "my_app",
    "client_secret": "secret_xxx",
    "redirect_uri": "https://app.example.com/callback",
    "code_verifier": "pkce_verifier_xxx"
  }'
```

**响应 200：**

```json
{
  "access_token": "eyJhbGci...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh_xxx..."
}
```

---

## POST /api/oauth/introspect

验证 token 有效性。

```bash
curl -X POST https://api.abdl-space.top/api/oauth/introspect \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGci..."}'
```

**响应 200：**

```json
{ "active": true, "client_id": "my_app", "user_id": 42 }
```

---

## POST /api/oauth/revoke

撤销 token。

```bash
curl -X POST https://api.abdl-space.top/api/oauth/revoke \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGci..."}'
```

---

## OAuth 客户端管理

见 `GET/POST/PUT/DELETE /api/oauth/clients`，**需管理员权限**。

```bash
# 查看已有客户端
curl https://api.abdl-space.top/api/oauth/clients \
  -H "Authorization: Bearer $TOKEN"

# 注册新 OAuth 客户端
curl -X POST https://api.abdl-space.top/api/oauth/clients \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My App",
    "redirect_uris": ["https://app.example.com/callback"],
    "scopes": ["read", "write"]
  }'

# 响应
{ "client_id": "abc123", "client_secret": "secret_xxx" }
```
