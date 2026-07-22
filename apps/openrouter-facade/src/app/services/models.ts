import {
  IMAGE_MODELS,
  resolveImageModel,
  resolveVideoModel,
  UnknownImageModelError,
  UnknownVideoModelError,
  VIDEO_MODELS,
} from "@pippit-bridge/core"
import { invalidRequest } from "../../errors.js"

export function resolveFacadeVideoModel(modelId: string): (typeof VIDEO_MODELS)[number] {
  try {
    return resolveVideoModel(modelId)
  } catch (error) {
    if (error instanceof UnknownVideoModelError) {
      throw invalidRequest(error.message, "model", "model_not_found")
    }
    throw error
  }
}

export function resolveFacadeImageModel(modelId: string): (typeof IMAGE_MODELS)[number] {
  try {
    return resolveImageModel(modelId)
  } catch (error) {
    if (error instanceof UnknownImageModelError) {
      throw invalidRequest(error.message, "model", "model_not_found")
    }
    throw error
  }
}
