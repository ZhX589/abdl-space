/**
 * API Worker 独立入口
 * 用于部署到 api.abdl-space.top (Cloudflare Workers)
 *
 * 部署命令:
 *   npx wrangler deploy --config wrangler-api.jsonc
 */
import app from './index'
import type { Env, JWTPayload } from './types/index'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

export default {
  async fetch(request: Request, env: AppType['Bindings'], ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx)
  }
}