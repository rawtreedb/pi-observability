import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi @returns {void} */
export default function scriptedModel(pi) {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("Use the synthetic lookup"), fauxToolCall("lookup", { key: "sample" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Synthetic result verified."),
  ]);
  pi.registerProvider(faux.provider);
  pi.registerTool({
    name: "lookup", label: "Lookup", description: "Look up synthetic data",
    parameters: Type.Object({ key: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: `Synthetic lookup result; token=${process.env.TEST_API_TOKEN}` }], details: undefined }),
  });
}
