import { existsSync } from "@std/fs";
import { join } from "@std/path";
import type { DatabaseManagement } from "./dbManagement.ts";
import { Vanilla } from "./serverSoftwares.ts";

const versionPattern = /version "([^"]*)"/;
const whichJava = new Deno.Command("sh", {
  args: ["-c", "which java"],
});

const defaultPaths = ["/nix/store", "/usr/lib/jvm", "/usr/java"];
const keywords = ["jre", "jdk", "temurin"];
const keywords_blacklist = ["minimal"];

const java_subdirs = ["bin/java", "jre/bin/java", "jdk/bin/java"];

type JavaResults = Record<number, { version: string; path: string }[]>;

function getJavaVersion(bin: string) {
  const command = new Deno.Command(bin, { args: ["-version"] });
  const output = command.outputSync();
  const text = new TextDecoder().decode(output.stderr);

  const match = versionPattern.exec(text);
  if (match) {
    const version = match[1].replaceAll("_", ".");
    if (version.startsWith("1.")) return version.slice(2);
    return version;
  }
}

export class JavaFinder {
  private _allJavas: JavaResults = {};
  private _preferedJavas: Record<number, string> = {};
  private _latestJava: string = "";
  private dbManager;

  get allJavas() {
    return this._allJavas;
  }
  get preferedJavas() {
    return this._preferedJavas;
  }
  get latestJava() {
    return this._latestJava;
  }

  constructor(dbManager: DatabaseManagement) {
    this.dbManager = dbManager;
    this.rescanJavas();
  }

  private findJavaVersions(paths: string[]) {
    const binaries = new Set<string>();
    const foundVersions: JavaResults = {};

    function addJavaPath(path: string) {
      binaries.add(path);

      const version = getJavaVersion(path);
      if (!version) return;

      const data = { version, path };
      const majorVersion = Number(version.split(".", 1)[0]);
      if (foundVersions[majorVersion]) {
        foundVersions[majorVersion].push(data);
      } else {
        foundVersions[majorVersion] = [data];
      }
    }

    // Method 1: Path fallback

    const output = whichJava.outputSync();
    const text = new TextDecoder().decode(output.stdout).replaceAll("\n", "");
    addJavaPath(Deno.realPathSync(text));

    // Method 2: Folders

    for (const store of paths) {
      if (!existsSync(store)) continue;
      for (const path of Deno.readDirSync(store)) {
        if (!path.isDirectory) continue;
        const filePath = Deno.realPathSync(join(store, path.name));
        if (binaries.has(filePath)) continue;

        // Step 1: Name Check
        let name: string;
        if (filePath.split("/")[1] == "nix") {
          const split_name = path.name.split("-");

          if (split_name.length == 1) continue;
          name = split_name.slice(1).join("-");
        } else {
          name = path.name;
        }

        if (!keywords.some((kw) => name.includes(kw))) continue;
        if (keywords_blacklist.some((kw) => name.includes(kw))) continue;

        // Step 2: Version recognition
        for (const candidate of java_subdirs) {
          const merged = join(filePath, candidate);
          if (existsSync(merged) && Deno.statSync(merged).isFile)
            addJavaPath(merged);
        }
      }
    }

    return foundVersions;
  }

  private sortJavaVersions(results: JavaResults) {
    const preferred_java_versions: Record<string, string> = {};

    for (const [major, instances] of Object.entries(results)) {
      instances.sort((a, b) =>
        b.version.localeCompare(a.version, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );

      preferred_java_versions[major] = instances[0].path;
    }

    return preferred_java_versions;
  }

  rescanJavas() {
    this._allJavas = this.findJavaVersions(
      defaultPaths.concat(this.dbManager.globalDB.additionalJavaPaths),
    );
    this._preferedJavas = this.sortJavaVersions(this._allJavas);

    const values = Object.values(this._preferedJavas);
    this._latestJava = values.at(-1)!;
  }

  async getJavaRuntimeForVersion(mcVersion: string) {
    const majorJavaVersion = await Vanilla.getJavaVersion(mcVersion);

    if (!(majorJavaVersion in this._preferedJavas)) {
      throw new Error(
        `No Java ${majorJavaVersion} runtime found. Minimal runtimes are not supported.`,
      );
    }

    return this._preferedJavas[majorJavaVersion];
  }
}
