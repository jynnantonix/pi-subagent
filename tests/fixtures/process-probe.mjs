import { acquireLease, sessionPaths } from "../../session-store.ts";

const lease = await acquireLease(sessionPaths(process.argv[2], process.argv[3]));
process.send?.({ event: "acquired" });
process.on("message", async (message) => {
  if (message === "release") {
    await lease.release();
    process.send?.({ event: "released" });
    process.exit(0);
  }
});
