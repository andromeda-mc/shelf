import { assertEquals } from "@std/assert";
import * as mod from "../lib/utils/date.ts";
import { configureLogger } from "../lib/logger.ts";

Deno.test(function mojangDateConversion() {
  configureLogger();

  const orig = new Date();
  orig.setMilliseconds(0);

  const origISO = orig.toISOString();

  const moj = mod.convToMojDate(orig);

  const back = mod.parseMojDate(moj);
  const backISO = back.toISOString();

  assertEquals(origISO, backISO);
});
