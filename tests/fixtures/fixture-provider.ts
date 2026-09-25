import { access, appendFile } from "node:fs/promises";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type AssistantMessage,
	type Api,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const absent = process.env.FIXTURE_REMOVE_REVIEWER === "1";
	pi.registerProvider("fixture", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "fixture-dummy-key",
		api: "fixture-api",
		models: [
			...(!absent
				? [
						{
							id: "reviewer",
							name: "Fixture Reviewer",
							reasoning: true,
							input: ["text" as const],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 32768,
							maxTokens: 4096,
						},
					]
				: []),
			{
				id: "other",
				name: "Fixture Other",
				reasoning: true,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 4096,
			},
		],
		streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 3,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
			void (async () => {
				try {
					await options?.onPayload?.({ fixture: true }, model);
					await options?.onResponse?.({ status: 200, headers: {} }, model);
					const user = context.messages.find((m) => m.role === "user");
					const userText =
						user?.role === "user"
							? typeof user.content === "string"
								? user.content
								: user.content
										.filter((p) => p.type === "text")
										.map((p) => p.text)
										.join("")
							: "";
					const controller = userText.startsWith("controller-case:")
						? (JSON.parse(userText.slice("controller-case:".length)) as {
								params: Record<string, unknown>;
								controllerTask: string;
							})
						: undefined;
					const prior = context.messages.some((m) => m.role === "assistant");
					await appendFile(
						process.env.FIXTURE_LOG!,
						`${JSON.stringify({ messages: context.messages, model: `${model.provider}/${model.id}`, tools: getCurrentTools(context.messages).map((t) => t.name), systemPrompt: getCurrentSystemPrompt(context.messages), reasoning: options?.reasoning })}\n`,
					);
					if (options?.signal?.aborted) throw new Error("aborted");
					if (userText.startsWith("Task: hold:") && process.env.FIXTURE_GATE) {
						const gate =
							userText.startsWith("Task: hold:0") && process.env.FIXTURE_RELEASE_FIRST
								? process.env.FIXTURE_RELEASE_FIRST
								: process.env.FIXTURE_GATE;
						while (
							!(await access(gate).then(
								() => true,
								() => false,
							))
						) {
							if (options?.signal?.aborted) throw new Error("aborted");
							await new Promise((resolve) => setTimeout(resolve, 20));
						}
					}
					if (userText.startsWith("Task: fail:")) throw new Error("fixture runtime failure");
					const text = controller
						? "controller-done"
						: process.env.FIXTURE_EMPTY_TEXT === "1"
							? ""
							: prior
								? "follow-up-answer"
								: "first-answer";
					stream.push({ type: "start", partial: message });
					if (controller && !context.messages.some((m) => m.role === "toolResult")) {
						const call = {
							type: "toolCall" as const,
							id: "fixture-subagent-call",
							name: "subagent",
							arguments: controller.params as ToolCall["arguments"],
						};
						message.content.push(call);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
						message.stopReason = "toolUse";
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}
					message.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					message.content[0] = { type: "text", text };
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
					message.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message });
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error";
					message.errorMessage = String(error);
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} finally {
					stream.end();
				}
			})();
			return stream;
		},
	});
}
