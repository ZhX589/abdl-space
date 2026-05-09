import type { JWTPayload } from '../types/index.ts'

const PBKDF2_ITERATIONS = 100000
const SALT_LENGTH = 16
const KEY_LENGTH = 64
const JWT_EXPIRES_IN = 7 * 24 * 60 * 60 * 1000

function arrayBufferToBase64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(str: string): ArrayBuffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const buffer = new ArrayBuffer(binary.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i)
  }
  return buffer
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBuffer(hex: string): ArrayBuffer {
  const buffer = new ArrayBuffer(hex.length / 2)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < hex.length; i += 2) {
    view[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return buffer
}

/**
 * 使用 PBKDF2 对密码进行哈希
 * @param password - 明文密码
 * @returns 格式为 "iterations$salt$derivedKey" 的哈希字符串
 */
export async function hashPassword(password: string): Promise<string> {
  const saltBuffer = new ArrayBuffer(SALT_LENGTH)
  const saltView = new Uint8Array(saltBuffer)
  crypto.getRandomValues(saltView)

  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    KEY_LENGTH * 8
  )
  const saltHex = arrayBufferToHex(saltBuffer)
  const derivedHex = arrayBufferToHex(derivedBits)
  return `${PBKDF2_ITERATIONS}$${saltHex}$${derivedHex}`
}

/**
 * 验证明文密码是否匹配存储的哈希
 * @param password - 明文密码
 * @param storedHash - 格式为 "iterations$salt$derivedKey" 的存储哈希
 * @returns 密码是否匹配
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$')
  if (parts.length !== 3) return false

  const iterations = parseInt(parts[0], 10)
  const saltHex = parts[1]
  const storedDerivedHex = parts[2]

  if (isNaN(iterations) || !saltHex || !storedDerivedHex) return false

  const saltBuffer = hexToBuffer(saltHex)
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    KEY_LENGTH * 8
  )
  const derivedHex = arrayBufferToHex(derivedBits)
  return derivedHex === storedDerivedHex
}

/**
 * 使用 HS256 算法签发 JWT
 * @param payload - JWT payload 数据
 * @param secret - 签名密钥
 * @returns JWT 字符串
 */
export async function signJWT(payload: Omit<JWTPayload, 'iat' | 'exp'>, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Date.now()
  const fullPayload: JWTPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRES_IN
  }

  const encoder = new TextEncoder()
  const headerB64 = arrayBufferToBase64url(encoder.encode(JSON.stringify(header)))
  const payloadB64 = arrayBufferToBase64url(encoder.encode(JSON.stringify(fullPayload)))
  const signInput = `${headerB64}.${payloadB64}`

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signInput))
  const signatureB64 = arrayBufferToBase64url(signature)

  return `${signInput}.${signatureB64}`
}

/**
 * 验证 JWT 并返回 payload
 * @param token - JWT 字符串
 * @param secret - 签名密钥
 * @returns 解码后的 payload 或 null（验证失败时）
 */
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [, payloadB64, signatureB64] = parts
  const encoder = new TextEncoder()
  const signInput = `${parts[0]}.${payloadB64}`

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const signature = base64urlDecode(signatureB64)
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signInput))
  if (!valid) return null

  try {
    const payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64))
    const payload: JWTPayload = JSON.parse(payloadJson)
    if (payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
