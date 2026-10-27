import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readerUrl = new URL('../scripts/push-evidence-reader.mjs', import.meta.url)
const { readTransportEvidence } = await import(readerUrl.href) as {
  readTransportEvidence: (path: string) => Promise<unknown>
}

describe('strict push evidence reader', () => {
  it('resolves undefined only for a missing file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'push-evidence-reader-'))
    await expect(readTransportEvidence(join(directory, 'absent.json'))).resolves.toBeUndefined()
  })

  it('parses complete JSON evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'push-evidence-reader-'))
    const path = join(directory, 'present.json')
    await writeFile(path, JSON.stringify({ processId: 4242, requestsAccepted: 1 }), 'utf8')
    await expect(readTransportEvidence(path)).resolves.toEqual({ processId: 4242, requestsAccepted: 1 })
  })

  it('rejects a malformed or partially written evidence file instead of reading it as absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'push-evidence-reader-'))
    const cases: Array<[string, string]> = [['empty.json', ''], ['partial.json', '{"processId":42']]
    for (const [name, content] of cases) {
      const path = join(directory, name)
      await writeFile(path, content, 'utf8')
      await expect(readTransportEvidence(path)).rejects.toThrow(SyntaxError)
    }
  })
})
