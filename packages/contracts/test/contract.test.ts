import { describe, expect, it } from "vitest"
import {
  addAccessKeyToolInputContract,
  byokCredentialCreateContract,
  deleteAccessKeyToolInputContract,
  downloadVideoToolInputContract,
  editVideoToolInputContract,
  emptyToolInputContract,
  generateImageToolInputContract,
  generateVideoToolInputContract,
  getVideoToolInputContract,
  inputReferenceContract,
  switchAccessKeyToolInputContract,
  WIDGET_MCP_INPUT_CONTRACTS,
} from "../src/index.js"

describe("RuntimeContract", () => {
  it("uses one schema for runtime acceptance and JSON Schema projection", () => {
    const accepted = {
      image_url: { url: "https://media.test/reference.png" },
      type: "image_url" as const,
    }
    expect(inputReferenceContract.parse(accepted)).toEqual(accepted)
    expect(inputReferenceContract.toJsonSchema()).toMatchObject({
      oneOf: expect.any(Array),
    })
    expect(() => inputReferenceContract.parse({
      image_url: { url: "file:///tmp/private.png" },
      type: "image_url",
    })).toThrow()
  })

  it("keeps strict empty MCP inputs aligned at parse and projection", () => {
    expect(emptyToolInputContract.parse({})).toEqual({})
    expect(() => emptyToolInputContract.parse({ unexpected: true })).toThrow()
    expect(emptyToolInputContract.toJsonSchema()).toMatchObject({
      additionalProperties: false,
      properties: {},
      type: "object",
    })
  })

  it("normalizes explicit MCP defaults in runtime parsers", () => {
    expect(generateImageToolInputContract.parse({
      model: "pippit/seedream-5.0",
      prompt: "paint",
    })).toMatchObject({ n: 1 })
    expect(editVideoToolInputContract.parse({
      annotations: [{
        at_ms: 100,
        instruction: "brighten",
        region: { height: 0.5, width: 0.5, x: 0, y: 0 },
      }],
      model: "pippit/seedance-2.0",
      segment: { end_ms: 1000, start_ms: 0 },
      source_job_id: "job",
    })).toMatchObject({ source_index: 0 })
    expect(downloadVideoToolInputContract.parse({ job_id: "job", output_path: "clips/result.mp4" }))
      .toMatchObject({ index: 0 })
  })

  it("runs the same acceptance and rejection corpus across every MCP contract", () => {
    const corpus = [
      [generateVideoToolInputContract, { model: "pippit/seedance-2.0", prompt: "go" }, { model: "x", prompt: "go", extra: true }],
      [generateImageToolInputContract, { model: "pippit/seedream-5.0-pro", prompt: "go", resolution: "2K" }, { model: "pippit/seedream-5.0", prompt: "go", resolution: "2K" }],
      [getVideoToolInputContract, { job_id: "job" }, { job_id: "" }],
      [downloadVideoToolInputContract, { job_id: "job", output_path: "clip.mp4" }, { job_id: "job", output_path: "../clip.mp4" }],
      [editVideoToolInputContract, {
        annotations: [{
          at_ms: 10,
          instruction: "change",
          region: { height: 0.2, width: 0.2, x: 0, y: 0 },
        }],
        model: "pippit/seedance-2.0",
        segment: { end_ms: 100, start_ms: 0 },
        source_job_id: "job",
      }, {
        annotations: [],
        model: "pippit/seedance-2.0",
        segment: { end_ms: 100, start_ms: 0 },
        source_job_id: "job",
      }],
      [addAccessKeyToolInputContract, { account_name: "primary" }, { account_name: "" }],
      [switchAccessKeyToolInputContract, { credential_id: "credential" }, { credential_id: "" }],
      [deleteAccessKeyToolInputContract, { confirm: true, credential_id: "credential" }, { confirm: false, credential_id: "credential" }],
    ] as const
    for (const [contract, accepted, rejected] of corpus) {
      expect(() => contract.parse(accepted)).not.toThrow()
      expect(() => contract.parse(rejected)).toThrow()
      expect(contract.toJsonSchema()).toMatchObject({ additionalProperties: false, type: "object" })
    }
  })

  it("keeps BYOK secret/default handling in the publishable contract", () => {
    expect(byokCredentialCreateContract.parse({ key: "ak-secret", provider: "pippit" })).toMatchObject({
      allowed_api_key_hashes: null,
      disabled: false,
      is_fallback: false,
      workspace_id: "00000000-0000-0000-0000-000000000000",
    })
    expect(() => byokCredentialCreateContract.parse({ key: "ak secret", provider: "pippit" })).toThrow()
  })

  it("projects and parses every Widget-only MCP input from the same contracts", () => {
    const imageUri = `pippit-image://artifact/${"a".repeat(64)}.png`
    const videoUri = `pippit-video://artifact/${"b".repeat(64)}`
    const corpus = {
      pippit_get_image: [{ image_job_id: `pimg_${"c".repeat(32)}` }, { image_job_id: "bad" }],
      pippit_read_image: [{ resource_uri: imageUri }, { resource_uri: "https://example.test/image.png" }],
      pippit_read_video_chunk: [
        { length: 1, offset: 0, resource_uri: videoUri },
        { length: 1024 * 1024 + 1, offset: 0, resource_uri: videoUri },
      ],
      pippit_resolve_latest_video: [{ anchor_job_id: "job" }, { anchor_job_id: " " }],
      pippit_reveal_image: [{ resource_uri: imageUri }, { resource_uri: `${imageUri}?secret=1` }],
    } as const

    expect(Object.keys(WIDGET_MCP_INPUT_CONTRACTS).sort()).toEqual(Object.keys(corpus).sort())
    for (const [name, contract] of Object.entries(WIDGET_MCP_INPUT_CONTRACTS)) {
      const [accepted, rejected] = corpus[name as keyof typeof corpus]
      expect(() => contract.parse(accepted), name).not.toThrow()
      expect(() => contract.parse(rejected), name).toThrow()
      expect(contract.toJsonSchema(), name).toMatchObject({ additionalProperties: false, type: "object" })
    }
  })
})
