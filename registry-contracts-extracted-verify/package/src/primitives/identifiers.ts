import { z } from "zod"
import { runtimeContract } from "../contract.js"

export const opaqueJobIdContract = runtimeContract(z.string().trim().min(1).max(16_384))
export const credentialIdContract = runtimeContract(z.uuid())
