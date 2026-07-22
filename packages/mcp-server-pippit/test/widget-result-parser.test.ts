import { describe, expect, it } from "vitest"
import { findWidgetJob, widgetTextContent } from "../src/widget/result-parser.js"

describe("browser-safe Widget result parser", () => {
  it("finds canonical and legacy jobs without crossing the depth bound", () => {
    expect(findWidgetJob({ result: { job: { id: "job-1", status: "completed" } } })).toMatchObject({
      id: "job-1",
      status: "completed",
    })
    expect(findWidgetJob({ result: { job_id: "legacy-1", status: "pending" } })).toMatchObject({
      id: "legacy-1",
      job_id: "legacy-1",
    })
    expect(findWidgetJob({ a: { b: { c: { d: { e: { f: { id: "too-deep", status: "completed" } } } } } } })).toBeUndefined()
  })

  it("reads only a valid text content block", () => {
    expect(widgetTextContent({ content: [{ type: "image", data: "x" }, { type: "text", text: "ready" }] })).toBe("ready")
    expect(widgetTextContent({ content: [{ type: "text", text: 1 }] })).toBeUndefined()
    expect(widgetTextContent(null)).toBeUndefined()
  })
})
