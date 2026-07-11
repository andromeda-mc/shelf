import { assertEquals } from "@std/assert";
import { ProcessMonitor } from "../lib/processMonitor.ts";
import { delay } from "@std/async";
import { configureLogger } from "../lib/logger.ts";

Deno.test(async function testOutputCapturing() {
  configureLogger();

  const watcher = new ProcessMonitor({ bin: "cat" });

  watcher.write("Hello world\n");

  await delay(50);

  assertEquals(
    watcher.history,
    "Hello world\nHello world\n",
    "Content mismatch",
  );
});
