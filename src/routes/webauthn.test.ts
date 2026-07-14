import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeChallenge, toArrayBuffer } from './webauthn.ts'

test('toArrayBuffer copies only the credential key view', () => {
  const source = new Uint8Array([9, 1, 2, 3, 9])
  assert.deepEqual([...new Uint8Array(toArrayBuffer(source.subarray(1, 4)))], [1, 2, 3])
})

test('consumeChallenge atomically binds id, ceremony type, and nullable user', async () => {
  let sql = ''
  let values: unknown[] = []
  const db = {
    prepare(statement: string) {
      sql = statement
      return {
        bind(...params: unknown[]) {
          values = params
          return { all: async () => ({ results: [{ challenge: 'expected' }] }) }
        },
      }
    },
  } as unknown as D1Database

  assert.equal(await consumeChallenge(db, 'id', 'authenticate', null), 'expected')
  assert.match(sql, /^DELETE FROM webauthn_challenges/)
  assert.match(sql, /user_id IS \?/)
  assert.match(sql, /RETURNING challenge/)
  assert.deepEqual(values, ['id', 'authenticate', null])
})
