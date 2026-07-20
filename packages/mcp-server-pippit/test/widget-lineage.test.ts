import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  createInMemoryPippitWidgetLineageStore,
  createPersistentPippitWidgetLineageStore,
} from "../src/widget-lineage.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pippit-widget-lineage-"))
  roots.push(value)
  return value
}

describe("Pippit widget job lineage", () => {
  it("resolves the newest descendant and rejects cycles", async () => {
    const store = createInMemoryPippitWidgetLineageStore()
    await store.record("A", "B")
    await store.record("B", "C")
    expect(await store.resolve("A")).toBe("C")
    await store.record("C", "A")
    await expect(store.resolve("A")).rejects.toThrow("cycle")
  })

  it("waits for an active regeneration before resolving", async () => {
    const store = createInMemoryPippitWidgetLineageStore()
    let finish!: () => void
    const pending = new Promise<void>(resolvePending => { finish = resolvePending })
    store.track("A", pending.then(() => store.record("A", "B")))
    const resolution = store.resolve("A")
    finish()
    await expect(resolution).resolves.toBe("B")
  })

  it("persists a private transitive lineage across store instances", async () => {
    const stateRoot = await root()
    const first = createPersistentPippitWidgetLineageStore({ root: stateRoot, scope: "facade-one" })
    await first.record("A", "B")
    await first.record("B", "C")

    const second = createPersistentPippitWidgetLineageStore({ root: stateRoot, scope: "facade-one" })
    expect(await second.resolve("A")).toBe("C")
    const [scopeDirectory] = await readdir(stateRoot)
    if (scopeDirectory === undefined) throw new Error("Missing lineage scope directory.")
    const sourceDirectories = await readdir(join(stateRoot, scopeDirectory))
    expect(sourceDirectories).toHaveLength(2)
    const recordPath = join(
      stateRoot,
      scopeDirectory,
      sourceDirectories[0]!,
      (await readdir(join(stateRoot, scopeDirectory, sourceDirectories[0]!)))[0]!,
    )
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(recordPath, "utf8")).not.toContain("facade-one")
  })

  it("isolates lineage by facade scope", async () => {
    const stateRoot = await root()
    const first = createPersistentPippitWidgetLineageStore({ root: stateRoot, scope: "facade-one" })
    const second = createPersistentPippitWidgetLineageStore({ root: stateRoot, scope: "facade-two" })
    await first.record("A", "B")
    await expect(first.resolve("A")).resolves.toBe("B")
    await expect(second.resolve("A")).resolves.toBe("A")
  })
})
