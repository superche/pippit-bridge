import {
  type ChatGptGenerateInput,
  type ChatGptImageInput,
} from "./app-schemas.js"

export function normalizeGenerateInput(input: ChatGptGenerateInput): Record<string, unknown> {
  const firstFrameUrl = input.first_frame?.download_url ?? input.first_frame_url
  const lastFrameUrl = input.last_frame?.download_url ?? input.last_frame_url
  const frameImages = [
    ...(firstFrameUrl === undefined
      ? []
      : [{ frame_type: "first_frame", image_url: { url: firstFrameUrl }, type: "image_url" }]),
    ...(lastFrameUrl === undefined
      ? []
      : [{ frame_type: "last_frame", image_url: { url: lastFrameUrl }, type: "image_url" }]),
  ]
  const inputReferences = [
    ...(input.images ?? []).map((file) => ({ image_url: { url: file.download_url }, type: "image_url" })),
    ...(input.image_urls ?? []).map((url) => ({ image_url: { url }, type: "image_url" })),
    ...(input.videos ?? []).map((file) => ({ type: "video_url", video_url: { url: file.download_url } })),
    ...(input.video_urls ?? []).map((url) => ({ type: "video_url", video_url: { url } })),
    ...(input.audios ?? []).map((file) => ({ audio_url: { url: file.download_url }, type: "audio_url" })),
    ...(input.audio_urls ?? []).map((url) => ({ audio_url: { url }, type: "audio_url" })),
  ]
  return {
    ...(input.aspect_ratio === undefined ? {} : { aspect_ratio: input.aspect_ratio }),
    ...(input.byok_id === undefined ? {} : { byok_id: input.byok_id }),
    ...(input.duration === undefined ? {} : { duration: input.duration }),
    ...(frameImages.length === 0 ? {} : { frame_images: frameImages }),
    idempotency_key: input.idempotency_key,
    ...(inputReferences.length === 0 ? {} : { input_references: inputReferences }),
    model: input.model,
    prompt: input.prompt,
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
  }
}

export function normalizeImageInput(input: ChatGptImageInput): Record<string, unknown> {
  const images = [
    ...(input.images ?? []).map((file) => ({ image_url: { url: file.download_url }, type: "image_url" })),
    ...(input.image_urls ?? []).map((url) => ({ image_url: { url }, type: "image_url" })),
  ]
  return {
    ...(input.byok_id === undefined ? {} : { byok_id: input.byok_id }),
    ...(images.length === 0 ? {} : { images }),
    model: input.model,
    ...(input.n === undefined ? {} : { n: input.n }),
    prompt: input.prompt,
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
  }
}
