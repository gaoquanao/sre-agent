import { Type, type TSchema } from 'typebox'
import type { JsonSchema } from '@sre/protocol'

/**
 * Translate the platform's JSON Schema subset into TypeBox, which is what Pi
 * validates tool arguments against. Anything with semantics TypeBox would
 * express differently (enum, oneOf, const) goes through `Type.Unsafe`, which
 * keeps the original schema verbatim.
 */
export function jsonSchemaToTypeBox(schema: JsonSchema | undefined): TSchema {
  if (schema === undefined || Object.keys(schema).length === 0) return Type.Unsafe({})

  const hasComplexSemantics =
    Array.isArray(schema.enum) || schema.oneOf !== undefined || schema.anyOf !== undefined || schema.const !== undefined
  if (hasComplexSemantics) return Type.Unsafe(schema as never)

  const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== 'null') : schema.type
  const options: Record<string, unknown> = {}
  if (typeof schema.description === 'string') options.description = schema.description
  if (schema.default !== undefined) options.default = schema.default

  switch (type) {
    case 'string':
      return Type.String(options)
    case 'number':
      return Type.Number(options)
    case 'integer':
      return Type.Integer(options)
    case 'boolean':
      return Type.Boolean(options)
    case 'null':
      return Type.Null()
    case 'array':
      return Type.Array(jsonSchemaToTypeBox(schema.items), options)
    case 'object': {
      const properties: Record<string, TSchema> = {}
      const required = new Set(schema.required ?? [])
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        const child = jsonSchemaToTypeBox(value)
        properties[key] = required.has(key) ? child : Type.Optional(child)
      }
      return Type.Object(properties, {
        ...options,
        additionalProperties: schema.additionalProperties === true,
      })
    }
    default:
      return Type.Unsafe(schema as never)
  }
}
