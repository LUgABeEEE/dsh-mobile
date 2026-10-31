import { mkdtemp, readFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareManagedLanSetup } from '../src/lan-setup.js'

describe('managed LAN rebind', () => {
  it('keeps the CA, updates the saved interface and re-signs the leaf for the new address', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-rebind-'))
    const setupFile = join(directory, 'mobile-access-setup.json')
    const controlFile = join(directory, 'mobile-access-control.json')
    const tlsDirectory = join(directory, 'tls')

    const first = await prepareManagedLanSetup({
      setupFile,
      controlFile,
      network: { name: 'Wi-Fi', address: '10.0.0.5', cidr: '10.0.0.0/24' },
      listenPort: 3443,
      dshPort: 3080,
      configureFirewall: false,
    })
    const caBefore = await readFile(join(tlsDirectory, 'ca.pem'), 'utf8')
    expect(first.origin).toBe('https://10.0.0.5:3443')

    const second = await prepareManagedLanSetup({
      setupFile,
      controlFile,
      network: { name: 'Ethernet', address: '10.0.0.9', cidr: '10.0.0.0/24' },
      listenPort: 3443,
      dshPort: 3080,
      configureFirewall: false,
    })

    // The CA identity is reused, so already-paired phones keep trusting the gateway.
    expect(await readFile(join(tlsDirectory, 'ca.pem'), 'utf8')).toBe(caBefore)

    // The saved setup follows the new interface.
    const saved = JSON.parse(await readFile(setupFile, 'utf8')) as { networkInterface?: string }
    expect(saved.networkInterface).toBe('Ethernet')
    expect(second.origin).toBe('https://10.0.0.9:3443')

    // The server leaf is re-signed for the new address.
    const leaf = new X509Certificate(await readFile(join(tlsDirectory, 'server-cert.pem'), 'utf8'))
    expect(leaf.subjectAltName ?? '').toContain('10.0.0.9')
  })
})
