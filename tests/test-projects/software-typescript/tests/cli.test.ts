import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

describe("sensor-summary CLI", () => {
  test("reports a time-weighted mean from a real CSV file", async () => {
    const child = Bun.spawn(
      [process.execPath, "src/cli.ts", "data/sample.csv"],
      { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    const status = await child.exited;

    expect(status).toBe(0);
    expect(JSON.parse(output)).toEqual({
      samples: 4,
      durationSeconds: 8,
      min: 10,
      max: 20,
      timeWeightedMean: 16.5,
    });
  });

  test("rejects a missing file argument", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    const status = await child.exited;

    expect(status).not.toBe(0);
    expect(error).toContain("Usage:");
  });
});
