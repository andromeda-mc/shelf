import { assertEquals } from "@std/assert";
import { ProcessMonitor } from "../lib/processMonitor.ts";

Deno.test(async function testOutputCapturing() {
  const watcher = new ProcessMonitor("cat");
  let timeoutId;

  try {
    const waitForEcho = new Promise<void>((resolve) => {
      watcher.addListener((output) => {
        assertEquals(output, "Hello world\n");
        resolve();
      });
      watcher.write("Hello world\n");
    });

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Timeout")), 1000);
    });

    await Promise.race([waitForEcho, timeout]);
  } finally {
    clearTimeout(timeoutId);
    watcher.terminate();
    await watcher.process.status;
  }
});
