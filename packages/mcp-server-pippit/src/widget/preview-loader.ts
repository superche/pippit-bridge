export interface WidgetPreviewTicket {
  generation: number
  signal: AbortSignal
}

export interface WidgetPreviewChunkPlan {
  bytes: number
  complete: boolean
  offset: number
}

export interface WidgetPreviewChunkMetadata extends WidgetPreviewChunkPlan {
  total_bytes: number
}

export class WidgetPreviewLoader {
  private controller: AbortController | undefined
  private generation = 0
  private objectUrl: string | undefined

  begin(): WidgetPreviewTicket {
    this.controller?.abort()
    this.controller = new AbortController()
    this.generation += 1
    return { generation: this.generation, signal: this.controller.signal }
  }

  current(ticket: WidgetPreviewTicket): boolean {
    return !ticket.signal.aborted && ticket.generation === this.generation
  }

  createObjectUrl(
    chunks: Uint8Array[],
    mimeType: string,
    create: (blob: Blob) => string,
    revoke: (url: string) => void,
  ): string {
    this.revokeObjectUrl(revoke)
    const parts = chunks.map(chunk => (
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
    ))
    this.objectUrl = create(new Blob(parts, { type: mimeType }))
    return this.objectUrl
  }

  hasObjectUrl(): boolean {
    return this.objectUrl !== undefined
  }

  revokeObjectUrl(revoke: (url: string) => void): void {
    if (this.objectUrl === undefined) return
    revoke(this.objectUrl)
    this.objectUrl = undefined
  }

  teardown(revoke: (url: string) => void): void {
    this.controller?.abort()
    this.controller = undefined
    this.generation += 1
    this.revokeObjectUrl(revoke)
  }
}

export function planWidgetPreviewChunks(
  totalBytes: number,
  chunkBytes: number,
  maximumBytes: number,
): WidgetPreviewChunkPlan[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
    throw new Error("The local video size is unavailable.")
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error("The local video chunk size is invalid.")
  }
  if (totalBytes > maximumBytes) {
    throw new Error("The local video is too large for an inline preview.")
  }
  const chunks: WidgetPreviewChunkPlan[] = []
  for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
    const bytes = Math.min(chunkBytes, totalBytes - offset)
    chunks.push({ bytes, complete: offset + bytes === totalBytes, offset })
  }
  return chunks
}

export function validateWidgetPreviewChunk(
  metadata: WidgetPreviewChunkMetadata | undefined,
  plan: WidgetPreviewChunkPlan,
  totalBytes: number,
): boolean {
  return metadata !== undefined &&
    metadata.offset === plan.offset &&
    metadata.bytes === plan.bytes &&
    metadata.total_bytes === totalBytes &&
    metadata.complete === plan.complete
}
