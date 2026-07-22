import { describe, expect, it } from "vitest"
import type { RuntimeContract } from "@pippit-bridge/contracts"
import { facadeRouteContracts } from "../src/app/route-contracts.js"
import { OPENAPI_DOCUMENT } from "../src/openapi.js"

interface OpenApiOperation {
  readonly operationId?: string
  readonly parameters?: readonly {
    readonly in?: unknown
    readonly name?: unknown
    readonly required?: unknown
    readonly schema?: unknown
  }[]
  readonly requestBody?: { readonly content?: Record<string, { readonly schema?: unknown }> }
  readonly responses?: Readonly<Record<string, unknown>>
  readonly security?: unknown
}

function projectedSchema(contract: RuntimeContract<unknown>): Readonly<Record<string, unknown>> {
  const { $schema: _schemaDialect, ...schema } = contract.toJsonSchema()
  return schema
}

describe("Facade route contract OpenAPI projection", () => {
  it("projects every public route's identity, security, inputs, and response statuses", () => {
    const paths = OPENAPI_DOCUMENT.paths as Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>
    for (const route of facadeRouteContracts()) {
      if (route.openApi === undefined) continue
      const operation = paths[route.openApi.path]?.[route.method]
      expect(operation, route.openApi.operationId).toBeDefined()
      expect(operation?.operationId).toBe(route.openApi.operationId)
      expect(operation?.security).toEqual([{
        [route.auth === "management" ? "managementBearer" : "runtimeBearer"]: [],
      }])

      const expectedParameters = [
        ...parametersFromContract("path", route.params),
        ...parametersFromContract("query", route.query),
      ]
      const actualParameters = operation?.parameters ?? []
      expect(actualParameters.map(parameter => ({
        in: parameter.in,
        name: parameter.name,
        required: parameter.required,
        schema: parameter.schema,
      })), route.openApi.operationId).toEqual(expectedParameters)

      const requestSchema = operation?.requestBody?.content?.["application/json"]?.schema
      expect(requestSchema, route.openApi.operationId).toEqual(
        route.body === undefined ? undefined : projectedSchema(route.body),
      )
      expect(Object.keys(operation?.responses ?? {}).map(Number).sort((left, right) => left - right))
        .toEqual([...route.responseStatuses].sort((left, right) => left - right))
      for (const status of route.responseStatuses.filter(status => status >= 400)) {
        expect(operation?.responses?.[String(status)], `${route.openApi.operationId}:${status}`)
          .toEqual({ $ref: "#/components/responses/Error" })
      }
      for (const status of route.responseStatuses.filter(status => status < 400)) {
        expect(operation?.responses?.[String(status)], `${route.openApi.operationId}:${status}`)
          .toEqual(route.successResponses?.[status])
      }
    }
  })
})

function parametersFromContract(
  location: "path" | "query",
  contract: RuntimeContract<unknown> | undefined,
): readonly Readonly<Record<string, unknown>>[] {
  if (contract === undefined) return []
  const schema = projectedSchema(contract)
  const properties = schema.properties as Readonly<Record<string, unknown>>
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  return Object.entries(properties).map(([name, propertySchema]) => {
    const hasDefault = propertySchema !== null && typeof propertySchema === "object" &&
      !Array.isArray(propertySchema) && "default" in propertySchema
    return {
      in: location,
      name,
      required: location === "path" || (required.has(name) && !hasDefault),
      schema: propertySchema,
    }
  })
}
