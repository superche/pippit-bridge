const SUPPORTED_RATIOS = [
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "1:1", value: 1 },
] as const

const SUPPORTED_RESOLUTIONS = [480, 720, 1080] as const

export interface InferredVideoGeometry {
  readonly aspectRatio: string
  readonly resolution: `${number}p`
}

interface Mp4Box {
  readonly contentOffset: number
  readonly end: number
  readonly type: string
}

function readBox(bytes: Uint8Array, offset: number, limit: number): Mp4Box | undefined {
  if (offset < 0 || limit > bytes.byteLength || limit - offset < 8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size32 = view.getUint32(offset)
  const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0)
  let contentOffset = offset + 8
  let size = size32
  if (size32 === 1) {
    if (limit - offset < 16) return undefined
    const size64 = view.getBigUint64(offset + 8)
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    size = Number(size64)
    contentOffset = offset + 16
  } else if (size32 === 0) {
    size = limit - offset
  }
  const end = offset + size
  if (size < contentOffset - offset || end > limit || end <= offset) return undefined
  return { contentOffset, end, type }
}

function trackDimensions(bytes: Uint8Array, start: number, end: number): { height: number; width: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = start; offset < end;) {
    const box = readBox(bytes, offset, end)
    if (box === undefined) return undefined
    if (box.type === "tkhd" && box.end - box.contentOffset >= 84) {
      const version = bytes[box.contentOffset]
      const matrixOffset = box.contentOffset + (version === 1 ? 52 : 40)
      const dimensionOffset = box.contentOffset + (version === 1 ? 88 : 76)
      if ((version !== 0 && version !== 1) || dimensionOffset + 8 > box.end) return undefined
      let width = view.getUint32(dimensionOffset) / 65_536
      let height = view.getUint32(dimensionOffset + 4) / 65_536
      const matrixA = view.getInt32(matrixOffset) / 65_536
      const matrixB = view.getInt32(matrixOffset + 4) / 65_536
      const matrixC = view.getInt32(matrixOffset + 12) / 65_536
      const matrixD = view.getInt32(matrixOffset + 16) / 65_536
      const quarterTurn = Math.abs(matrixA) < 0.001 && Math.abs(matrixD) < 0.001
        && Math.abs(matrixB) > 0.9 && Math.abs(matrixC) > 0.9
      if (quarterTurn) [width, height] = [height, width]
      if (width > 0 && height > 0 && width <= 65_535 && height <= 65_535) return { height, width }
    }
    offset = box.end
  }
  return undefined
}

function videoDimensions(bytes: Uint8Array): { height: number; width: number } | undefined {
  for (let topOffset = 0; topOffset < bytes.byteLength;) {
    const top = readBox(bytes, topOffset, bytes.byteLength)
    if (top === undefined) return undefined
    if (top.type === "moov") {
      for (let offset = top.contentOffset; offset < top.end;) {
        const box = readBox(bytes, offset, top.end)
        if (box === undefined) return undefined
        if (box.type === "trak") {
          const dimensions = trackDimensions(bytes, box.contentOffset, box.end)
          if (dimensions !== undefined) return dimensions
        }
        offset = box.end
      }
    }
    topOffset = top.end
  }
  return undefined
}

export function inferVideoGeometry(bytes: Uint8Array): InferredVideoGeometry | undefined {
  const dimensions = videoDimensions(bytes)
  if (dimensions === undefined) return undefined
  const observedRatio = dimensions.width / dimensions.height
  const aspectRatio = SUPPORTED_RATIOS.reduce((nearest, candidate) => (
    Math.abs(Math.log(observedRatio / candidate.value)) < Math.abs(Math.log(observedRatio / nearest.value))
      ? candidate
      : nearest
  )).label
  const observedResolution = Math.min(dimensions.width, dimensions.height)
  const resolution = SUPPORTED_RESOLUTIONS.reduce((nearest, candidate) => (
    Math.abs(Math.log(observedResolution / candidate)) < Math.abs(Math.log(observedResolution / nearest))
      ? candidate
      : nearest
  ))
  return { aspectRatio, resolution: `${resolution}p` }
}

export function inferVideoAspectRatio(bytes: Uint8Array): string | undefined {
  return inferVideoGeometry(bytes)?.aspectRatio
}
