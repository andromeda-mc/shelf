import { configureLogger } from "../lib/logger.ts";
import * as mod from "../lib/settingsManager.ts";
import { assertEquals } from "@std/assert";

Deno.test(function testPropertyParsing() {
  configureLogger();

  // Numbers
  assertEquals(mod.parseProperty("123"), 123);
  assertEquals(mod.parseProperty("123.456"), 123.456);

  // Strings and stripping
  assertEquals(mod.parseProperty("I like trains"), "I like trains");
  assertEquals(mod.parseProperty("  nyoom nyoom\n"), "nyoom nyoom");

  // Booleans
  assertEquals(mod.parseProperty("true"), true);
  assertEquals(mod.parseProperty("false"), false);
  assertEquals(mod.parseProperty("null"), "null");
  assertEquals(mod.parseProperty("undefined"), "undefined");

  assertEquals(mod.parseProperty(""), null);
});
