import { getTimeRotatingFileSink } from "@logtape/file";
import { configureSync, getConsoleSink } from "@logtape/logtape";
import { logPath } from "./static/dbManagement.ts";

export function configureLogger() {
  configureSync({
    sinks: {
      console: getConsoleSink(),
      file: getTimeRotatingFileSink({ directory: logPath }),
    },
    loggers: [
      { category: "Shelf", sinks: ["console", "file"] },
      {
        category: ["logtape", "meta"],
        sinks: ["console"],
        lowestLevel: "error",
      },
    ],
  });
}
