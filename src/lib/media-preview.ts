import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon'

const PREVIEW_PATH_PREFIX = '/api/v1/media/preview/v3/'
const PREVIEW_LONG_EDGE = 720
const MAX_IMAGE_EDGE = 8192
const MAX_IMAGE_PIXELS = 12_000_000
export const MAX_MEDIA_PREVIEW_SOURCE_BYTES = 10 * 1024 * 1024

const TRUSTED_MEDIA_HOSTS = new Set([
  'img.abdl-space.top',
  'cloudflare-imgbed-790.pages.dev',
])

function isTrustedMediaUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && TRUSTED_MEDIA_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function encodeSource(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeSource(value: string): string | null {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

export function buildMediaPreviewUrl(source: string, apiOrigin = 'https://api.abdl-space.top'): string {
  if (!isTrustedMediaUrl(source)) return source
  return `${apiOrigin.replace(/\/$/, '')}${PREVIEW_PATH_PREFIX}${encodeSource(source)}`
}

export function parseMediaPreviewSource(pathname: string): string | null {
  if (!pathname.startsWith(PREVIEW_PATH_PREFIX)) return null
  const encoded = pathname.slice(PREVIEW_PATH_PREFIX.length)
  const source = encoded && !encoded.includes('/') ? decodeSource(encoded) : null
  return source && isTrustedMediaUrl(source) ? source : null
}

export function calculateMediaPreviewSize(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null
  const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function validImageDimensions(width: number, height: number): { width: number; height: number } | null {
  if (width < 1 || height < 1 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) return null
  return { width, height }
}

export function inspectMediaImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return validImageDimensions(view.getUint32(16), view.getUint32(20))
  }

  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return validImageDimensions(bytes[6] | bytes[7] << 8, bytes[8] | bytes[9] << 8)
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = bytes[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const length = bytes[offset + 2] << 8 | bytes[offset + 3]
      if (length < 2 || offset + 2 + length > bytes.length) return null
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return validImageDimensions(bytes[offset + 7] << 8 | bytes[offset + 8], bytes[offset + 5] << 8 | bytes[offset + 6])
      }
      offset += 2 + length
    }
  }

  if (bytes.length >= 30 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') {
    const kind = new TextDecoder().decode(bytes.slice(12, 16))
    if (kind === 'VP8X') {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
      return validImageDimensions(width, height)
    }
  }
  return null
}

export function canonicalMediaPreviewCacheUrl(value: string): string {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function resizeMediaPreview(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number; contentType: string } | null {
  let source: PhotonImage | null = null
  let preview: PhotonImage | null = null
  try {
    if (!inspectMediaImageDimensions(bytes)) return null
    source = PhotonImage.new_from_byteslice(bytes)
    const size = calculateMediaPreviewSize(source.get_width(), source.get_height())
    if (!size) return null
    preview = resize(source, size.width, size.height, SamplingFilter.Lanczos3)
    const pixels = preview.get_raw_pixels()
    let opaque = true
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) {
        opaque = false
        break
      }
    }
    return opaque
      ? { bytes: preview.get_bytes_jpeg(80), contentType: 'image/jpeg', ...size }
      : { bytes: preview.get_bytes_webp(), contentType: 'image/webp', ...size }
  } catch {
    return null
  } finally {
    preview?.free()
    source?.free()
  }
}

export async function fetchTrustedMediaSource(source: string): Promise<Uint8Array | null> {
  let current = source
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    if (!isTrustedMediaUrl(current)) return null
    const response = await fetch(current, { redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return null
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('image/')) return null
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > MAX_MEDIA_PREVIEW_SOURCE_BYTES || !response.body) return null

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MEDIA_PREVIEW_SOURCE_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }
  return null
}
