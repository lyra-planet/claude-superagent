/** Downloads Feishu message images for the router to look at during assessment, as MCP image content. */
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { FeishuRef } from './feishu-read.ts'

/** Extracts Feishu image keys from message text so keys remain paired with the originating message; arbitrary remote IDs are not accepted. */
export function admissionImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])]
}

/** An image the model sees: base64 `data` of one of the formats Claude reads. */
export interface ImageContent { data: string; mediaType: ImageMediaType }
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
/** The largest image an assessment reads, in bytes; Claude refuses larger ones. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export interface AdmissionImage {
  source_message_id: string
  image_key: string
  image: ImageContent
}

export async function readAdmissionImage(commands: Commands, ref: FeishuRef, text: string, imageKey: string, stateDir: string, signal: AbortSignal): Promise<AdmissionImage> {
  if (!admissionImageKeys(text).includes(imageKey)) throw new Error('Choose an image key from this source message')
  const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/).parse(ref.messageId)
  signal.throwIfAborted()
  const directory = await mkdtemp(join(stateDir, 'admission-image-'))
  try {
    const result = z.object({ saved_path: z.string() }).parse(await commands.withSignal(signal).lark([
      'im', '+messages-resources-download', '--message-id', messageId, '--file-key', imageKey, '--type', 'image', '--output', './image',
    ], directory))
    const path = await realpath(result.saved_path)
    if (dirname(path) !== await realpath(directory)) throw new Error('Image download returned a path outside its temporary directory')
    const mediaTypes: Record<string, ImageMediaType> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
    const mediaType = mediaTypes[extname(path).toLowerCase()]
    if (!mediaType) throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
    const file = await stat(path)
    if (!file.isFile() || file.size > MAX_IMAGE_BYTES) throw new Error('The image exceeds the deployment byte limit or is not a regular file')
    const data = await readFile(path, { signal })
    signal.throwIfAborted()
    return { source_message_id: messageId, image_key: imageKey, image: { data: data.toString('base64'), mediaType } }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
