import { z } from "zod"

export type JsonSchema = Readonly<Record<string, unknown>>

export interface RuntimeContract<T> {
  readonly schema: z.ZodType<T>
  parse(value: unknown): T
  toJsonSchema(): JsonSchema
}

export function runtimeContract<T>(schema: z.ZodType<T>): RuntimeContract<T> {
  return {
    schema,
    parse(value) {
      return schema.parse(value)
    },
    toJsonSchema() {
      return z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as JsonSchema
    },
  }
}
