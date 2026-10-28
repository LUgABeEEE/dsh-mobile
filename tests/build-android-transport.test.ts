import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const transport = await import(new URL('../scripts/build-android-transport.mjs', import.meta.url).href) as {
  ABI_TARGETS: Readonly<Record<string, { rust: string; clang: string; machine: number }>>
  inspectElf: (bytes: Buffer, expectedMachine: number) => { machine: number; loadAlignments: string[] }
  parseOptions: (args: readonly string[]) => { abis: string[]; output: string; ndk?: string }
  verifyApkEntries: (entries: readonly string[], abis: readonly string[]) => void
  verifyCompatibilityApkEntries: (entries: readonly string[]) => void
  verifyNativeDex: (bytes: Buffer) => void
}

function elf64(machine: number): Buffer {
  const bytes = Buffer.alloc(256, 0)
  bytes.writeUInt32LE(0x464c457f, 0)
  bytes[4] = 2
  bytes[5] = 1
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(machine, 18)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(2, 56)
  bytes.writeUInt32LE(1, 64)
  bytes.writeBigUInt64LE(16_384n, 64 + 48)
  bytes.writeUInt32LE(0x6474e552, 120)
  bytes.writeBigUInt64LE(0n, 120 + 16)
  bytes.writeBigUInt64LE(16_384n, 120 + 40)
  return bytes
}

describe('android transport build helpers', () => {
  it('pins both supported ABIs to Android API 29 toolchains', () => {
    expect(Object.keys(transport.ABI_TARGETS).sort()).toEqual(['arm64-v8a', 'x86_64'])
    expect(transport.ABI_TARGETS['arm64-v8a']).toMatchObject({ rust: 'aarch64-linux-android', machine: 183 })
    expect(transport.ABI_TARGETS['x86_64']).toMatchObject({ rust: 'x86_64-linux-android', machine: 62 })
  })

  it('rejects unknown, empty or duplicate ABI selections', () => {
    expect(transport.parseOptions(['--ndk', '/ndk']).abis).toEqual(['arm64-v8a', 'x86_64'])
    expect(transport.parseOptions(['--ndk', '/ndk', '--abis', 'x86_64']).abis).toEqual(['x86_64'])
    expect(() => transport.parseOptions(['--ndk', '/ndk', '--abis', 'armeabi-v7a'])).toThrow('unsupported or duplicate ABI')
    expect(() => transport.parseOptions(['--ndk', '/ndk', '--abis', 'x86_64,x86_64'])).toThrow('unsupported or duplicate ABI')
    expect(() => transport.parseOptions(['--unknown', 'x'])).toThrow('invalid Android transport argument')
  })

  it('validates ELF machine and 16 KiB alignment without external tools', () => {
    expect(transport.inspectElf(elf64(183), 183)).toMatchObject({ machine: 183 })
    expect(() => transport.inspectElf(elf64(62), 183)).toThrow('differs from its APK ABI')
    expect(() => transport.inspectElf(Buffer.alloc(16), 183)).toThrow('little-endian ELF64')
  })

  it('rejects a full APK without the JVM TLS verifier or preserved JNI names', () => {
    const names = ['Lio/github/sayach/dshmobile/IrohNative;',
      'Lorg/rustls/platformverifier/CertificateVerifier;', 'Lorg/rustls/platformverifier/VerificationResult;',
      'nativeInitialize', 'nativeConnect', 'nativeClose', 'nativeStatus']
    expect(() => transport.verifyNativeDex(Buffer.from(names.join('\0')))).not.toThrow()
    for (const missing of names) {
      expect(() => transport.verifyNativeDex(Buffer.from(names.filter(name => name !== missing).join('\0'))))
        .toThrow('APK is missing a JNI/TLS runtime entry')
    }
  })

  it('rejects native leftovers in compatibility packages and unknown variants', () => {
    expect(() => transport.verifyCompatibilityApkEntries(['classes.dex', 'assets/THIRD_PARTY_NOTICES.txt'])).not.toThrow()
    expect(() => transport.verifyCompatibilityApkEntries(['lib/x86_64/libdsh_mobile_iroh_android_transport.so']))
      .toThrow('compatibility APK must not contain native libraries')
    expect(() => transport.parseOptions(['--variant', 'unknown'])).toThrow('unsupported APK variant')
    expect(() => transport.parseOptions(['--variant', 'compatibility'])).not.toThrow()
  })

  it('requires exactly one transport library per selected ABI', () => {
    const entries = ['lib/arm64-v8a/libdsh_mobile_iroh_android_transport.so', 'lib/x86_64/libdsh_mobile_iroh_android_transport.so', 'classes.dex']
    expect(() => transport.verifyApkEntries(entries, ['arm64-v8a', 'x86_64'])).not.toThrow()
    expect(() => transport.verifyApkEntries(entries.slice(1), ['arm64-v8a', 'x86_64'])).toThrow('exactly one arm64-v8a')
    expect(() => transport.verifyApkEntries([...entries, 'lib/armeabi-v7a/libdsh_mobile_iroh_android_transport.so'], ['arm64-v8a', 'x86_64']))
      .toThrow('unselected transport ABI')
  })

  it('builds the vendored workspace by explicit manifest path', () => {
    // The Rust workspace lives in native/, not the repository root: invoking
    // cargo without --manifest-path fails before compiling anything.
    const source = readFileSync(new URL('../scripts/build-android-transport.mjs', import.meta.url), 'utf8')
    expect(source).toContain("'--manifest-path'")
    expect(source).toContain("join(ROOT, 'native', 'Cargo.toml')")
  })
})
