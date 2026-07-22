import { describe, expect, it } from "vitest"
import { inferVideoAspectRatio, inferVideoGeometry } from "../src/media/video-aspect-ratio.js"

function box(type: string, content: Uint8Array): Buffer {
  const output = Buffer.alloc(8 + content.byteLength)
  output.writeUInt32BE(output.byteLength, 0)
  output.write(type, 4, 4, "ascii")
  Buffer.from(content).copy(output, 8)
  return output
}

function video(width: number, height: number, quarterTurn = false): Buffer {
  const trackHeader = Buffer.alloc(84)
  if (quarterTurn) {
    trackHeader.writeInt32BE(1 << 16, 44)
    trackHeader.writeInt32BE(-(1 << 16), 52)
  } else {
    trackHeader.writeInt32BE(1 << 16, 40)
    trackHeader.writeInt32BE(1 << 16, 56)
  }
  trackHeader.writeInt32BE(1 << 30, 72)
  trackHeader.writeUInt32BE(width * 65_536, 76)
  trackHeader.writeUInt32BE(height * 65_536, 80)
  return Buffer.concat([box("ftyp", new Uint8Array(4)), box("moov", box("trak", box("tkhd", trackHeader)))])
}

describe("inferVideoAspectRatio", () => {
  it("maps MP4 track dimensions to the nearest supported Pippit ratio", () => {
    expect(inferVideoAspectRatio(video(1_920, 1_080))).toBe("16:9")
    expect(inferVideoAspectRatio(video(720, 1_280))).toBe("9:16")
    expect(inferVideoAspectRatio(video(1_000, 980))).toBe("1:1")
  })

  it("maps the intrinsic short edge to a supported Pippit resolution", () => {
    expect(inferVideoGeometry(video(1_280, 720))).toEqual({ aspectRatio: "16:9", resolution: "720p" })
    expect(inferVideoGeometry(video(480, 854))).toEqual({ aspectRatio: "9:16", resolution: "480p" })
    expect(inferVideoGeometry(video(2_160, 3_840))).toEqual({ aspectRatio: "9:16", resolution: "1080p" })
  })

  it("honors quarter-turn track matrices and rejects malformed boxes", () => {
    expect(inferVideoAspectRatio(video(1_920, 1_080, true))).toBe("9:16")
    expect(inferVideoAspectRatio(new Uint8Array([0, 0, 0, 24, 109, 111, 111, 118]))).toBeUndefined()
  })
})
