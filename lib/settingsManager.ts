import { existsSync } from "@std/fs";
import { instancesPath } from "./static/dbManager.ts";
import { basename, join, relative } from "@std/path";
import { type ServerManager } from "./mcServerManager.ts";
import { ServerStates } from "./static/mcServerManager.ts";
import { getUUID } from "./minecraftApi.ts";
import { getMojDate } from "./utils/date.ts";
import { log } from "./server/httpWsServer.ts";

type PropertyTypes = string | number | boolean | null;
type Properties = Record<string, PropertyTypes>;

interface Whitelist {
  uuid: string;
  name: string;
}

interface Bans extends Whitelist {
  created: string;
  source: string;
  expires: "forever";
  reason?: string;
}

interface OpSettings {
  level: number;
  bypassesPlayerLimit: boolean;
}
type Ops = Whitelist & OpSettings;

const whitelistFile = "whitelist.json";
const opsFile = "ops.json";
const bansFile = "banned-players.json";
const propertiesFile = "server.properties";

const settingFiles = [whitelistFile, opsFile, bansFile, propertiesFile];

export function parseProperty(val: string): PropertyTypes {
  val = val.trim();

  const numb = Number(val);
  if (val === "true") {
    return true;
  } else if (val === "false") {
    return false;
  } else if (val === "") {
    return null;
  } else if (!isNaN(numb)) {
    return numb;
  }
  return val;
}

export class SettingsManager {
  serverManager;
  watcher;

  private _whitelists = new Map<string, Whitelist[]>();
  private _ops = new Map<string, Ops[]>();
  private _bans = new Map<string, Bans[]>();
  private _properties = new Map<string, Properties>();

  getWhitelist(serverUUID: string) {
    return this._whitelists.get(serverUUID) ?? [];
  }

  getOps(serverUUID: string) {
    return this._ops.get(serverUUID) ?? [];
  }

  getBans(serverUUID: string) {
    return this._bans.get(serverUUID) ?? [];
  }

  getProperties(serverUUID: string) {
    const properties = this._properties.get(serverUUID);
    if (!properties) throw "not ready: server.properties";
    return properties;
  }

  constructor(serverManager: ServerManager) {
    this.serverManager = serverManager;

    this.updateAllServers();

    const watcher = Deno.watchFs(instancesPath);
    this.watcher = watcher;

    (async () => {
      for await (const event of watcher) {
        this.handleEvent(event);
      }
    })().then(() => {
      log("SettingsManager", "Watcher has closed");
    });
  }

  private updateAllServers() {
    for (const server of Deno.readDirSync(instancesPath)) {
      if (!server.isDirectory) continue;
      const uuid = server.name;
      log("SettingsManager", `Updating Server UUID "${uuid}"`);

      this.updateWhitelist(uuid);
      this.updateOps(uuid);
      this.updateBans(uuid);
      try {
        this.updateProperties(uuid);
      } catch (err) {
        if (err === "not ready: server.properties") {
          log("SettingsManager", `Server UUID "${uuid}" has no properties yet`);
        } else {
          throw err;
        }
      }
    }
  }

  private handleEvent(event: Deno.FsEvent) {
    for (const path of event.paths) {
      const filename = basename(path);

      if (
        !settingFiles.includes(filename) ||
        event.kind !== "modify" ||
        !path.startsWith(instancesPath)
      ) {
        return;
      }

      const subpath = relative(instancesPath, path);
      const serverUUID = subpath.split("/", 1)[0];

      switch (filename) {
        case whitelistFile:
          this.updateWhitelist(serverUUID);
          break;
        case opsFile:
          this.updateOps(serverUUID);
          break;
        case bansFile:
          this.updateBans(serverUUID);
          break;
        case propertiesFile:
          this.updateProperties(serverUUID);
          break;
      }
    }
  }

  // General Stuff

  private getPath(serverUUID: string, file: string, create: boolean = false) {
    const instancePath = join(instancesPath, serverUUID);
    if (!existsSync(instancePath)) throw "unknown: server";

    const filePath = join(instancePath, file);
    if (!existsSync(filePath) && !create) return;
    return filePath;
  }

  // Whitelist / whitelist.json

  private updateWhitelist(serverUUID: string) {
    const whitelistPath = this.getPath(serverUUID, whitelistFile);
    if (!whitelistPath) {
      this._whitelists.set(serverUUID, []);
      return;
    }

    const content = Deno.readTextFileSync(whitelistPath);
    const whitelist: Whitelist[] = JSON.parse(content);
    this._whitelists.set(serverUUID, whitelist);
  }

  private saveWhitelist(serverUUID: string) {
    const whitelistPath = this.getPath(serverUUID, whitelistFile, true)!;
    const whitelist = this.getProperties(serverUUID);

    const content = JSON.stringify(whitelist);
    return Deno.writeTextFileSync(whitelistPath, content);
  }

  async addToWhitelist(serverUUID: string, playerName: string) {
    const entry = await getUUID(playerName);
    const whitelist = this.getWhitelist(serverUUID);

    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      this.serverManager.write(serverUUID, `\nwhitelist add ${entry.name}\n`);
    } else {
      whitelist.push(entry);

      this.saveWhitelist(serverUUID);
    }
  }

  removeFromWhitelist(serverUUID: string, playerName: string) {
    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      this.serverManager.write(
        serverUUID,
        `\nwhitelist remove ${playerName}\n`,
      );
    } else {
      const whitelist = this.getWhitelist(serverUUID);

      const index = whitelist.findIndex(
        (entry) => entry.name.toLowerCase() !== playerName.toLowerCase(),
      );
      whitelist.splice(index, 1);

      this.saveWhitelist(serverUUID);
    }
  }

  // Ops / ops.json

  private updateOps(serverUUID: string) {
    const opsPath = this.getPath(serverUUID, opsFile);
    if (!opsPath) {
      this._ops.set(serverUUID, []);
      return;
    }

    const content = Deno.readTextFileSync(opsPath);
    const ops: Ops[] = JSON.parse(content);
    this._ops.set(serverUUID, ops);
  }

  private saveOps(serverUUID: string) {
    const opsPath = this.getPath(serverUUID, opsFile, true)!;
    const ops = this.getOps(serverUUID);

    const content = JSON.stringify(ops);
    return Deno.writeTextFileSync(opsPath, content);
  }

  async addToOps(serverUUID: string, playerName: string) {
    const entry = await getUUID(playerName);
    const ops = this.getOps(serverUUID);

    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      this.serverManager.write(serverUUID, `\nop ${entry.name}\n`);
    } else {
      ops.push({ ...entry, bypassesPlayerLimit: false, level: 4 });

      this.saveOps(serverUUID);
    }
  }

  removeFromOps(serverUUID: string, playerName: string) {
    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      this.serverManager.write(serverUUID, `\ndeop ${playerName}\n`);
    } else {
      const ops = this.getOps(serverUUID);

      const index = ops.findIndex(
        (entry) => entry.name.toLowerCase() !== playerName.toLowerCase(),
      );
      ops.splice(index, 1);

      this.saveOps(serverUUID);
    }
  }

  modifyOp(serverUUID: string, uuid: string, config: Partial<OpSettings>) {
    const ops = this.getOps(serverUUID);
    if (!ops) {
      return;
    }

    const idx = ops.findIndex((entry) => entry.uuid === uuid);
    if (idx === -1) {
      return;
    }

    ops[idx] = { ...ops[idx], ...config };

    this.saveOps(serverUUID);
  }

  // Bans / banned-players.json

  private updateBans(serverUUID: string) {
    const bansPath = this.getPath(serverUUID, bansFile);
    if (!bansPath) {
      this._bans.set(serverUUID, []);
      return;
    }

    const content = Deno.readTextFileSync(bansPath);
    const bans: Bans[] = JSON.parse(content);
    this._bans.set(serverUUID, bans);
  }

  private saveBans(serverUUID: string) {
    const bansPath = this.getPath(serverUUID, bansFile, true)!;
    const bans = this.getBans(serverUUID);

    const content = JSON.stringify(bans);
    return Deno.writeTextFileSync(bansPath, content);
  }

  async banPlayer(serverUUID: string, playerName: string, reason?: string) {
    const entry = await getUUID(playerName);
    const bans = this.getBans(serverUUID);

    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      const command = `ban ${entry.name} ${reason}`.trim();
      this.serverManager.write(serverUUID, `\n${command}\n`);
    } else {
      const created = getMojDate(new Date());
      bans.push({
        ...entry,
        expires: "forever",
        reason,
        source: "Server",
        created,
      });

      this.saveBans(serverUUID);
    }
  }

  unbanPlayer(serverUUID: string, playerName: string) {
    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      this.serverManager.write(serverUUID, `\npardon ${playerName}\n`);
    } else {
      const bans = this.getBans(serverUUID);

      const index = bans.findIndex(
        (entry) => entry.name.toLowerCase() !== playerName.toLowerCase(),
      );
      bans.splice(index, 1);

      this.saveBans(serverUUID);
    }
  }

  // Properties / server.properties

  private updateProperties(serverUUID: string) {
    const propertiesPath = this.getPath(serverUUID, propertiesFile);
    if (!propertiesPath) {
      this._properties.delete(serverUUID);
      throw "not ready: server.properties";
    }
    const content = Deno.readTextFileSync(propertiesPath);

    const entries: [string, PropertyTypes][] = content
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => line.split("=", 2))
      .map(([key, value]) => [key, parseProperty(value)]);
    const properties = Object.fromEntries(entries);

    this._properties.set(serverUUID, properties);
  }

  private savePropertiesFile(serverUUID: string) {
    const propertiesPath = this.getPath(serverUUID, propertiesFile);
    if (!propertiesPath) throw "not ready: server.properties";

    const properties = this.getProperties(serverUUID);

    const string = Object.entries(properties)
      .map(
        ([key, value]) => key + "=" + (value !== null ? value.toString() : ""),
      )
      .join("\n");

    Deno.writeTextFileSync(propertiesPath, string);
  }

  setProperty(serverUUID: string, newProperties: Properties) {
    const properties = this.getProperties(serverUUID);
    const result = Object.assign(properties, newProperties);

    this._properties.set(serverUUID, result);
  }
}
