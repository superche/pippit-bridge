import type { RuntimeContract } from "@pippit-bridge/contracts"
import { facadeRouteContracts } from "./app/route-contracts.js"
import { OPENAPI_BASE_DOCUMENT } from "./openapi/base-document.js"

type OpenApiObject = Readonly<Record<string, unknown>>

interface SourceOperation extends OpenApiObject {
  readonly operationId?: unknown
  readonly parameters?: readonly OpenApiObject[]
  readonly responses?: Readonly<Record<string, OpenApiObject>>
}

function projectedSchema(contract: RuntimeContract<unknown>): OpenApiObject {
  const { $schema: _schemaDialect, ...schema } = contract.toJsonSchema()
  return schema
}

function resolvedParameter(parameter: OpenApiObject): OpenApiObject {
  const reference = parameter.$ref
  if (typeof reference !== "string") return parameter
  const prefix = "#/components/parameters/"
  if (!reference.startsWith(prefix)) throw new Error(`Unsupported OpenAPI parameter reference ${reference}.`)
  const name = reference.slice(prefix.length)
  const resolved = (OPENAPI_BASE_DOCUMENT.components.parameters as Record<string, OpenApiObject>)[name]
  if (resolved === undefined) throw new Error(`OpenAPI parameter component ${name} is missing.`)
  return resolved
}

function parametersFromContract(
  operationId: string,
  operation: SourceOperation,
  location: "path" | "query",
  contract: RuntimeContract<unknown> | undefined,
): readonly OpenApiObject[] {
  if (contract === undefined) return []
  const schema = projectedSchema(contract)
  const properties = schema.properties
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error(`OpenAPI ${operationId} ${location} contract is not an object schema.`)
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const presentation = (operation.parameters ?? []).map(resolvedParameter)
  return Object.entries(properties as Record<string, unknown>).map(([name, propertySchema]) => {
    const source = presentation.find(parameter => parameter.in === location && parameter.name === name)
    const hasDefault = propertySchema !== null && typeof propertySchema === "object" &&
      !Array.isArray(propertySchema) && "default" in propertySchema
    return {
      ...(typeof source?.description === "string" ? { description: source.description } : {}),
      in: location,
      name,
      required: location === "path" || (required.has(name) && !hasDefault),
      schema: propertySchema,
    }
  })
}

function generatedParameters(
  operationId: string,
  operation: SourceOperation,
  params: RuntimeContract<unknown> | undefined,
  query: RuntimeContract<unknown> | undefined,
): readonly OpenApiObject[] {
  const generated = [
    ...parametersFromContract(operationId, operation, "path", params),
    ...parametersFromContract(operationId, operation, "query", query),
  ]
  const sourceKeys = new Set((operation.parameters ?? []).map(resolvedParameter).map(
    parameter => `${String(parameter.in)}:${String(parameter.name)}`,
  ))
  const generatedKeys = new Set(generated.map(parameter => `${String(parameter.in)}:${String(parameter.name)}`))
  if (sourceKeys.size !== generatedKeys.size || [...sourceKeys].some(key => !generatedKeys.has(key))) {
    throw new Error(`OpenAPI operation ${operationId} has parameters outside its route contracts.`)
  }
  return generated
}

function generatedResponses(
  operationId: string,
  responseStatuses: readonly number[],
  successfulResponses: Readonly<Record<number, OpenApiObject>>,
): Readonly<Record<string, OpenApiObject>> {
  return Object.fromEntries(responseStatuses.map(status => {
    if (status >= 400) return [String(status), { $ref: "#/components/responses/Error" }]
    const successful = successfulResponses[status]
    if (successful === undefined) throw new Error(`OpenAPI operation ${operationId} lacks success response ${status}.`)
    return [String(status), successful]
  }))
}

function generatedOpenApiPaths(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const source = OPENAPI_BASE_DOCUMENT.paths as Readonly<Record<string, Readonly<Record<string, unknown>>>>
  const paths: Record<string, Record<string, unknown>> = {}
  const selected = new Set<string>()
  for (const route of facadeRouteContracts()) {
    const openApi = route.openApi
    if (openApi === undefined) continue
    const operation = source[openApi.path]?.[route.method] as SourceOperation | undefined
    if (operation?.operationId !== openApi.operationId) {
      throw new Error(`OpenAPI operation ${route.method.toUpperCase()} ${openApi.path} is missing or mismatched.`)
    }
    const security = [{ [route.auth === "management" ? "managementBearer" : "runtimeBearer"]: [] }]
    const parameters = generatedParameters(openApi.operationId, operation, route.params, route.query)
    paths[openApi.path] ??= {}
    paths[openApi.path]![route.method] = {
      ...operation,
      operationId: openApi.operationId,
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(route.body === undefined ? {} : {
        requestBody: {
          content: { "application/json": { schema: projectedSchema(route.body) } },
          required: true,
        },
      }),
      responses: generatedResponses(openApi.operationId, route.responseStatuses, route.successResponses ?? {}),
      security,
    }
    selected.add(`${route.method} ${openApi.path}`)
  }
  for (const [path, methods] of Object.entries(source)) {
    for (const method of Object.keys(methods)) {
      if (!selected.has(`${method} ${path}`)) {
        throw new Error(`OpenAPI operation ${method.toUpperCase()} ${path} has no Facade route contract.`)
      }
    }
  }
  return paths
}

export const OPENAPI_DOCUMENT = {
  ...OPENAPI_BASE_DOCUMENT,
  paths: generatedOpenApiPaths(),
} as const
