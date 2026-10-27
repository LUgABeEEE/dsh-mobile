import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readerUrl = new URL('../scripts/push-evidence-reader.mjs', import.meta.url)
const { readTransportEvidence } = await import(readerUrl.href) as {
  readTransportEvidence: (path: string) => Promise<unknown>
}

const temporaryRoots: string[] = []
const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'push-evidence-reader-'))
  temporaryRoots.push(root)
  return root
}

describe('strict push evidence reader', () => {
  it('resolves undefined only for a missing file', async () => {
    const directory = await temporaryRoot()
    await expect(readTransportEvidence(join(directory, 'absent.json'))).resolves.toBeUndefined()
  })

  it('parses complete JSON evidence', async () => {
    const directory = await temporaryRoot()
    const path = join(directory, 'present.json')
    await writeFile(path, JSON.stringify({ processId: 4242, requestsAccepted: 1 }), 'utf8')
    await expect(readTransportEvidence(path)).resolves.toEqual({ processId: 4242, requestsAccepted: 1 })
  })

  it('rejects a malformed or partially written evidence file instead of reading it as absent', async () => {
    const directory = await temporaryRoot()
    const cases: Array<[string, string]> = [['empty.json', ''], ['partial.json', '{"processId":42']]
    for (const [name, content] of cases) {
      const path = join(directory, name)
      await writeFile(path, content, 'utf8')
      await expect(readTransportEvidence(path)).rejects.toThrow(SyntaxError)
      await expect(readFile(path, 'utf8')).resolves.toBe(content)
    }
  })
})

for (const root of temporaryRoots) await rm(root, { recursive: true, force: true })
