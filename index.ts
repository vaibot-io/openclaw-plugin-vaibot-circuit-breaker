import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createCircuitBreaker } from "./src/plugin.js";

export default function register(api: OpenClawPluginApi) {
  createCircuitBreaker(api).register();
}
