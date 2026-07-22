import { z } from "zod"
import { runtimeContract } from "../contract.js"

export const httpUrlSchema = z.url().refine(
  value => /^https?:/iu.test(value),
  "Only HTTP(S) reference URLs are supported",
)

export const httpUrlContract = runtimeContract(httpUrlSchema)
