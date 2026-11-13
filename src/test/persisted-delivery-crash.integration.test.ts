import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { scratchDirectory } from "./scratch-directory.helper.js";

test("a SIGKILL after commit but before receipt preserves the delivery for recovery", async () => {
  const directory = scratchDirectory("persisted-crash-");
  const runner = fileURLToPath(
    new URL("./persisted-delivery-crash.runner.ts", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", runner, directory, "crash"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  try {
    await expect
      .poll(() => output, { timeout: 10_000 })
      .toContain("committed-before-receipt");
    expect(output).not.toContain('"ok"');
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    const restarted = spawnSync(
      process.execPath,
      ["--import", "tsx", runner, directory, "recover"],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(restarted.status, restarted.stderr + errors).toBe(0);
    expect(JSON.parse(restarted.stdout)).toEqual({
      ok: true,
      persisted: true,
      duplicate: true,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
});
