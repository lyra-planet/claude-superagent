import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { MAX_IMAGE_BYTES, admissionImageKeys, readAdmissionImage } from '../src/sources/feishu-image.ts'
import type { FeishuRef } from '../src/sources/feishu-read.ts'

// Adapted: upstream saved the image through DSH's attachment service, after checking that the Session's model reads images,
// and answered the attachment's reference. Here the image comes back as MCP image content, base64 data and its media type,
// up to the bytes Claude reads; there is no attachment service or model check.
let directory: string
let lark: MockInstance<Commands['lark']>
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const source: FeishuRef = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
const text = '![Image](img_source) Plan mode'
const signal = () => new AbortController().signal
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'admission-image-test-'))
  lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async (args: string[], cwd?: string) => {
    expect(args).toEqual(['im', '+messages-resources-download', '--message-id', 'om_source', '--file-key', 'img_source', '--type', 'image', '--output', './image'])
    expect(cwd).toContain(directory)
    const saved_path = join(cwd!, 'image.png'); await writeFile(saved_path, 'data')
    return { saved_path }
  })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })
it('retains the source-message pairing, answers the image as content and removes temporary files', async () => {
  expect(admissionImageKeys('![Image](img_source) {"image_key":"img_second"} img_source')).toEqual(['img_source', 'img_second'])
  expect(await readAdmissionImage(commands, source, text, 'img_source', directory, signal())).toEqual({ source_message_id: 'om_source', image_key: 'img_source',
    image: { data: Buffer.from('data').toString('base64'), mediaType: 'image/png' } })
  expect(await readdir(directory)).toEqual([])
})
it('rejects arbitrary keys before downloading', async () => {
  await expect(readAdmissionImage(commands, source, text, '../img_other', directory, signal())).rejects.toThrow('source message')
  await expect(readAdmissionImage(commands, { ...source, messageId: '../om_other' }, text, 'img_source', directory, signal())).rejects.toThrow()
  expect(lark).not.toHaveBeenCalled()
})
it('cleans up failed downloads without returning an image', async () => {
  lark.mockRejectedValueOnce(new Error('Resource permission denied'))
  await expect(readAdmissionImage(commands, source, text, 'img_source', directory, signal())).rejects.toThrow('permission denied')
  expect(await readdir(directory)).toEqual([])
})
it('refuses escaped output paths, oversize files and unsupported types', async () => {
  const outside = join(directory, 'outside.png'); await writeFile(outside, 'data')
  lark.mockResolvedValueOnce({ saved_path: outside })
  await expect(readAdmissionImage(commands, source, text, 'img_source', directory, signal())).rejects.toThrow('outside')
  for (const [name, bytes, error] of [['image.png', MAX_IMAGE_BYTES + 1, 'byte limit'], ['image.svg', 4, 'supported']] as const) {
    lark.mockImplementationOnce(async (_args, cwd) => {
      const saved_path = join(cwd!, name); await writeFile(saved_path, Buffer.alloc(bytes)); return { saved_path }
    })
    await expect(readAdmissionImage(commands, source, text, 'img_source', directory, signal())).rejects.toThrow(error)
  }
  expect(await readdir(directory)).toEqual(['outside.png'])
})
