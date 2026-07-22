import { z } from "zod"
import { runtimeContract } from "../contract.js"
import { httpUrlSchema } from "../primitives/http-url.js"

const urlReferenceValue = z.object({ url: httpUrlSchema }).strict()

export const imageUrlReferenceSchema = z.object({
  image_url: urlReferenceValue,
  type: z.literal("image_url"),
}).strict()

export const audioUrlReferenceSchema = z.object({
  audio_url: urlReferenceValue,
  type: z.literal("audio_url"),
}).strict()

export const videoUrlReferenceSchema = z.object({
  type: z.literal("video_url"),
  video_url: urlReferenceValue,
}).strict()

export const inputReferenceSchema = z.discriminatedUnion("type", [
  imageUrlReferenceSchema,
  audioUrlReferenceSchema,
  videoUrlReferenceSchema,
])

export const frameImageSchema = imageUrlReferenceSchema.extend({
  frame_type: z.enum(["first_frame", "last_frame"]),
})

export const inputReferenceContract = runtimeContract(inputReferenceSchema)
export const frameImageContract = runtimeContract(frameImageSchema)
