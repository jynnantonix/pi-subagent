import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv[2] === "ignore-term") {
  process.on("SIGTERM", () => {});
  const args = process.argv.slice(3);
  writeFileSync(join(process.env.HOME, "probe-descriptor"), args[args.indexOf("--subagent-launch") + 1]);
  writeFileSync(join(process.env.HOME, "probe-ready"), "ready");
  setInterval(() => {}, 1000);
} else if (
  [
    "fragmented",
    "exit-before-response",
    "malformed",
    "receipt-not-boolean",
    "receipt-rejected-empty",
    "receipt-rejected-invalid",
    "length",
    "settled-aborted",
    "recovered-length",
    "recovered-abort",
    "unsettled-recovery",
  ].includes(process.argv[2])
) {
  const args = process.argv.slice(3);
  const descriptor = JSON.parse(readFileSync(args[args.indexOf("--subagent-launch") + 1], "utf8"));
  const saved = JSON.parse(readFileSync(descriptor.paths.config, "utf8"));
  writeFileSync(
    descriptor.receiptPath,
    JSON.stringify({
      version: 1,
      token: descriptor.token,
      ready: process.argv[2] === "receipt-not-boolean" ? "yes" : !process.argv[2].startsWith("receipt-rejected"),
      ...(process.argv[2] === "receipt-rejected-empty" ? { error: "" } : {}),
      piSessionId: saved.piSessionId,
    }),
  );
  const emit = (event, newline = "\n") => process.stdout.write(JSON.stringify(event) + newline);
  emit({ type: "agent_start" }, "\r\n");
  if (
    [
      "fragmented",
      "receipt-not-boolean",
      "receipt-rejected-empty",
      "receipt-rejected-invalid",
      "length",
      "settled-aborted",
      "recovered-length",
      "recovered-abort",
      "unsettled-recovery",
    ].includes(process.argv[2])
  ) {
    const text = "🥳\u2028line";
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "fixture-api",
      provider: "fixture",
      model: "reviewer",
      stopReason: process.argv[2].includes("length") ? "length" : "stop",
      timestamp: Date.now(),
      usage: {
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const event = Buffer.from(JSON.stringify({ type: "message_end", message }) + "\r\n");
    const unicode = event.indexOf(Buffer.from("🥳"));
    process.stdout.write(event.subarray(0, unicode + 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.stdout.write(event.subarray(unicode + 2));
    if (["recovered-length", "recovered-abort", "unsettled-recovery"].includes(process.argv[2])) {
      emit({ type: "agent_settled", aborted: process.argv[2] === "recovered-abort" });
      emit({ type: "agent_start" });
      emit({ type: "message_end", message: { ...message, stopReason: "stop" } });
      if (process.argv[2] !== "unsettled-recovery") emit({ type: "agent_settled", aborted: false }, "");
    } else {
      emit({ type: "agent_settled", aborted: process.argv[2] === "settled-aborted" }, "");
    }
  } else if (process.argv[2] === "malformed") {
    process.stdout.write("{not-json}\n");
    emit({ type: "agent_settled" });
  }
} else {
  const { acquireLease, sessionPaths } = await import("../../session-store.ts");
  const lease = await acquireLease(sessionPaths(process.argv[2], process.argv[3]));
  process.send?.({ event: "acquired" });
  process.on("message", async (message) => {
    if (message === "release") {
      await lease.release();
      process.send?.({ event: "released" });
      process.exit(0);
    }
  });
}
