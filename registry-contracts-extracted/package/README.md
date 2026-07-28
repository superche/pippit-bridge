# `@pippit-bridge/contracts`

Shared runtime contracts for Pippit Bridge MCP and HTTP surfaces.

The package exposes Zod-backed `RuntimeContract<T>` values that provide the same parser and
draft-7 JSON Schema projection used by the MCP server, Facade routes, and generated OpenAPI.
Surface-specific mappings remain separate so MCP arguments are not treated as HTTP provider
options.

```ts
import { credentialIdContract } from "@pippit-bridge/contracts"

const credentialId = credentialIdContract.parse(input)
const jsonSchema = credentialIdContract.toJsonSchema()
```

Requires Node.js 22 or newer.
