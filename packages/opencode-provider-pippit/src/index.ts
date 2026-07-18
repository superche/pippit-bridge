import type { PluginModule } from "@opencode-ai/plugin"
import { PippitPlugin } from "./plugin.js"

const plugin: PluginModule = {
  id: "pippit.opencode-provider",
  server: PippitPlugin,
}

export default plugin
export type {
  DeviceAuthorizationOptions,
  PippitPluginOptions,
} from "./options.js"
