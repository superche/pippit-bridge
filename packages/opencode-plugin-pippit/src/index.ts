import type { PluginModule } from "@opencode-ai/plugin"
import { PippitPlugin } from "./plugin.js"

const plugin: PluginModule = {
  id: "pippit.opencode-plugin",
  server: PippitPlugin,
}

export default plugin
export type { PippitPluginOptions } from "./options.js"
