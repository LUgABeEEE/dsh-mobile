import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface JavaScriptExpression { readonly __jsExpr: string }

const jsExpressionType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data as string }),
})
const schema = yaml.JSON_SCHEMA.extend(jsExpressionType)
const source = readFileSync(resolve(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected mapping')
  return value as Record<string, unknown>
}

function mobileRow(): Record<string, unknown> {
  const patches = yaml.load(source, { schema }) as unknown[]
  const rows = patches.flatMap(patch => (record(patch).insert as unknown[] | undefined) ?? [patch]).map(record)
  const matches = rows.filter(row => row.id === 'mobile-access')
  if (matches.length !== 1) throw new Error('expected one mobile-access row')
  return matches[0]!
}

function rows(): Record<string, unknown>[] {
  const patches = yaml.load(source, { schema }) as unknown[]
  return patches.flatMap(patch => (record(patch).insert as unknown[] | undefined) ?? [patch]).map(record)
}

function evaluate(value: unknown): unknown {
  const expression = record(value).__jsExpr
  if (typeof expression !== 'string') throw new TypeError('expected JavaScript scalar')
  const run = Function('dshHomePath', `"use strict"; return (${expression});`) as (
    homePath: (path: string) => string,
  ) => unknown
  return run(path => `/dsh-home/${path}`)
}

describe('stock DSH bundle patch', () => {
  it('adds one ordinary dual-face plugin and no core replacement rows', () => {
    const row = mobileRow()
    expect(row).toMatchObject({ id: 'mobile-access', name: 'dsh-mobile', inject: ['webServer', 'connection'] })
    expect(source).not.toContain('pluginInventory')
    expect(source).not.toContain('requestAuth')
    expect(source).not.toMatch(/^\s*- id: connection$/mu)
  })

  it('leaves the directory picker to DSH instead of composing a second one', () => {
    // Since DSH 0.2.1 the `directory-picker` row is `-auto`, which mounts both
    // of its faces itself; a second picker collides on the single
    // `directoryFlow` slots and removes the Add workspace action. The dedicated
    // Mobile page registers its own flow from the client face instead.
    expect(rows().some(row => typeof row.id === 'string' && row.id.startsWith('directory-picker'))).toBe(false)
    expect(rows().some(row => typeof row.name === 'string' && row.name.includes('directory-picker'))).toBe(false)
  })

  it('starts disabled until the setup CLI writes the durable control state', () => {
    const config = record(mobileRow().config)
    expect(config.initiallyEnabled).toBe(false)
    expect(config.tls).toEqual({ mode: 'disabled' })
  })

  it('keeps generated files under DSH_HOME without assuming a local checkout path', () => {
    const config = record(mobileRow().config)
    expect(evaluate(config.setupFile)).toBe('/dsh-home/mobile-access/setup.json')
    expect(evaluate(config.stateFile)).toBe('/dsh-home/mobile-access/devices.json')
    expect(evaluate(config.controlFile)).toBe('/dsh-home/mobile-access/control.json')
    expect(evaluate(config.customCssFile)).toBe('/dsh-home/mobile-access/mobile.css')
    expect(evaluate(config.customScriptFile)).toBe('/dsh-home/mobile-access/mobile.js')
  })

  it('keeps the inert fallback listener loopback-only', () => {
    const config = record(mobileRow().config)
    expect(config.listenHost).toBe('127.0.0.1')
    expect(config.allowedCidrs).toEqual(['127.0.0.0/8'])
  })
})
