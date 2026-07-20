import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon'
import { encode } from 'blurhash'

const MAX_SAMPLE_SIZE = 32

export async function generateBlurhash(file: Blob): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null

  let image: PhotonImage | null = null
  let sample: PhotonImage | null = null

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    image = PhotonImage.new_from_byteslice(bytes)

    const width = image.get_width()
    const height = image.get_height()
    if (width < 1 || height < 1) return null

    const scale = Math.min(1, MAX_SAMPLE_SIZE / Math.max(width, height))
    const sampleWidth = Math.max(1, Math.round(width * scale))
    const sampleHeight = Math.max(1, Math.round(height * scale))
    sample = resize(image, sampleWidth, sampleHeight, SamplingFilter.Triangle)

    return encode(
      new Uint8ClampedArray(sample.get_raw_pixels()),
      sampleWidth,
      sampleHeight,
      4,
      3
    )
  } catch {
    return null
  } finally {
    sample?.free()
    image?.free()
  }
}
