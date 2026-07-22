import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { PippitCredentialSource } from "./auth.js"
import { PIPPIT_MAX_WAIT_SECONDS, type PippitVideoService } from "./generation.js"
import { type PippitPluginOptions } from "./options.js"
import { normalizeToolError, resultOutput } from "./plugin-support.js"

export function createGetVideoTool(
  options: PippitPluginOptions,
  credentials: PippitCredentialSource,
  videos: Pick<PippitVideoService, "get">,
): ToolDefinition {
  const schema = tool.schema
  return tool({
    description:
      "Check a Pippit video run, optionally wait for completion, and download completed videos into the current worktree.",
    args: {
      account_id: schema
        .string()
        .uuid()
        .optional()
        .describe(
          "Explicit managed account for an unbound run. A saved run binding always wins and must match this value.",
        ),
      download: schema.boolean().default(true),
      max_wait_seconds: schema
        .number()
        .int()
        .min(1)
        .max(PIPPIT_MAX_WAIT_SECONDS)
        .default(PIPPIT_MAX_WAIT_SECONDS),
      output_directory: schema.string().min(1).optional(),
      run_id: schema.string().min(1),
      thread_id: schema.string().min(1),
      wait_for_completion: schema.boolean().default(false),
    },
    async execute(args, context) {
      const download = args.download ?? true
      const maxWaitSeconds = args.max_wait_seconds ?? PIPPIT_MAX_WAIT_SECONDS
      const outputDirectory = args.output_directory ?? options.outputDirectory
      const waitForCompletion = args.wait_for_completion ?? false
      if (download) {
        await context.ask({
          always: [],
          metadata: {
            ...(args.account_id === undefined ? {} : { account_id: args.account_id }),
            output_directory: outputDirectory,
            run_id: args.run_id,
            target_origin: options.baseURL,
          },
          patterns: [options.baseURL, outputDirectory, args.run_id],
          permission: "pippit_download_video",
        })
      }
      context.metadata({ title: "Checking Pippit video", metadata: { run_id: args.run_id } })
      try {
        const credential = await credentials.readForRun(
          args.run_id,
          args.thread_id,
          args.account_id,
        )
        const result = await videos.get({
          accessKey: credential.accessKey,
          download,
          maxWaitSeconds,
          outputDirectory,
          rootDirectory: context.worktree,
          runId: args.run_id,
          signal: context.abort,
          threadId: args.thread_id,
          waitForCompletion,
        })
        return {
          metadata: {
            run_id: result.runId,
            status: result.status,
            ...(credential.accountId === undefined ? {} : { account_id: credential.accountId }),
          },
          output: resultOutput(result, credential),
          title: `Pippit video · ${result.status}`,
        }
      } catch (error) {
        throw normalizeToolError(error)
      }
    },
  })
}
