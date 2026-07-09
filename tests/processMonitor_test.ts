import { assertEquals } from "@std/assert";
import { ProcessMonitor } from "../lib/processMonitor.ts";
import { delay } from "@std/async";

Deno.test(async function testOutputCapturing() {
  const watcher = new ProcessMonitor({ bin: "cat" });

  watcher.write("Hello world\n");

  await delay(50);

  assertEquals(
    watcher.history,
    "Hello world\nHello world\n",
    "Content mismatch",
  );
});
