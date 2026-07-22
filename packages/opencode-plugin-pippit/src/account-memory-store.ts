import {
  cloneState,
  emptyState,
  storedStateSchema,
  type PippitAccountStore,
  type PippitAccountStoreMutation,
  type StoredPippitAccountState,
  type StoredState,
} from "./account-state.js"

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: (() => void) | undefined
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }
}

export class MemoryPippitAccountStore implements PippitAccountStore {
  private readonly mutex = new AsyncMutex()
  private state: StoredState

  constructor() {
    this.state = emptyState()
  }

  async read(): Promise<StoredState> {
    return this.mutex.runExclusive(async () => cloneState(this.state))
  }

  async update<T>(operation: (state: StoredState) => PippitAccountStoreMutation<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const current = cloneState(this.state)
      const mutation = operation(current)
      this.state = storedStateSchema.parse(cloneState(mutation.state))
      return mutation.result
    })
  }
}

export class LazyPippitAccountStore implements PippitAccountStore {
  private readonly factory: () => Promise<PippitAccountStore>
  private store: Promise<PippitAccountStore> | undefined

  constructor(factory: () => Promise<PippitAccountStore>) {
    this.factory = factory
  }

  async read(): Promise<StoredPippitAccountState> {
    return (await this.resolve()).read()
  }

  async update<T>(
    operation: (state: StoredPippitAccountState) => PippitAccountStoreMutation<T>,
  ): Promise<T> {
    return (await this.resolve()).update(operation)
  }

  private resolve(): Promise<PippitAccountStore> {
    this.store ??= this.factory()
    return this.store
  }
}
