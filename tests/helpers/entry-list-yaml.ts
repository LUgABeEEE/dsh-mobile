import { JSON_SCHEMA, defineScalarTag, load } from 'js-yaml'

/** The `!!js` scalar dialect used by `cordis.patch.yml`: the expression stays a node. */
export interface JsExpression {
  readonly __jsExpr: string
}

function isJsExpression(value: unknown): value is JsExpression {
  return typeof value === 'object' && value !== null
    && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string'
}

const jsExpressionTag = defineScalarTag<JsExpression>('tag:yaml.org,2002:js', {
  resolve: source => ({ __jsExpr: source }),
  identify: isJsExpression,
  represent: data => data.__jsExpr,
})

/**
 * The entry-list YAML dialect `@deepseek-ai/cordis-plugin-include` mounts, declared for
 * js-yaml 5. The include package exports the same dialect as a js-yaml 4 schema, which
 * version 5 cannot load, so this repeats its tag name, construction and predicate.
 */
const entryListSchema = JSON_SCHEMA.withTags(jsExpressionTag)

/** Parse one entry-list document with the `!!js` dialect above. */
export function loadEntryList(source: string): unknown {
  return load(source, { schema: entryListSchema })
}
