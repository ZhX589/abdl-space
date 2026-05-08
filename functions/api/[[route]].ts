import app from '../../src/index'
import type { PagesFunction } from '@cloudflare/workers-types'

export const onRequest: PagesFunction = async (context) => {
  return app.fetch(context.request, context.env, context)
}
