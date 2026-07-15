import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types/index.ts'
import { queryOne } from '../lib/db.ts'

interface ConnectionState {
  accountId: string
  deviceId: string
  connectedAt: number
}

/**
 * 每用户 Durable Object — 管理 WebSocket 连接与实时事件分发
 * 使用 Hibernation API 降低空闲成本
 */
export class UserPresence extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // 应用层 ping/pong，不唤醒休眠对象
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // 内部推送路由 — 只能由 binding 调用，不暴露公网
    if (url.pathname === '/push' && request.method === 'POST') {
      const payload = await request.text()
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(payload) } catch {}
      }
      return new Response('ok')
    }

    // WebSocket 升级
    const upgrade = request.headers.get('Upgrade')
    if (upgrade !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.ctx.acceptWebSocket(server)

    // 保存连接元数据
    const accountId = request.headers.get('X-Verified-Account-Id') ?? 'unknown'
    const deviceId = request.headers.get('X-Device-Id') ?? 'unknown'
    const connState: ConnectionState = { accountId, deviceId, connectedAt: Date.now() }
    server.serializeAttachment(connState)

    // 查询当前用户最大事件 ID 作为同步边界
    let syncBoundary = 0
    try {
      const userId = parseInt(accountId.split('_').pop() ?? '0')
      if (userId > 0) {
        const maxRow = await queryOne<{ max_id: number }>(
          this.env.abdl_space_db,
          'SELECT MAX(id) as max_id FROM message_events WHERE user_id = ?',
          [userId],
        )
        syncBoundary = maxRow?.max_id ?? 0
      }
    } catch {}

    // 立即发送 sync.ready（在 accept 之后、查询期间的事件会被缓冲）
    try {
      server.send(JSON.stringify({ type: 'sync.ready', sync_boundary: syncBoundary }))
    } catch {}

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return
    // 客户端消息暂不处理（v1 只做服务端推送）
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    ws.close(code, reason)
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    // 连接错误，静默处理
  }
}
