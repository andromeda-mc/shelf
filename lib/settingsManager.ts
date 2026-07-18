import { existsSync } from "@std/fs";
import { instancesPath } from "./static/dbManagement.ts";
import { basename, join, relative } from "@std/path";
import { type ServerManager } from "./mcServerManager.ts";
import { ServerStates } from "./static/mcServerManager.ts";
import { getUUID } from "./minecraftApi.ts";
import { convToMojDate, mojDatePattern, parseMojDate } from "./utils/date.ts";
import { getLogger } from "@logtape/logtape";
import * as v from "@valibot/valibot";

type PropertyTypes = string | number | boolean | null;
type Properties = Record<string, PropertyTypes>;

const WhitelistEntrySchema = v.object({
  uuid: v.pipe(v.string(), v.uuid()),
  name: v.pipe(v.string(), v.nonEmpty()),
});

const WhitelistSchema = v.array(WhitelistEntrySchema);

type Whitelist = v.InferOutput<typeof WhitelistSchema>;

const BansSchema = v.array(
  v.intersect([
    WhitelistEntrySchema,
    v.object({
      created: v.pipe(v.string(), v.regex(mojDatePattern)),
      source: v.pipe(v.string(), v.nonEmpty()),
      expires: v.literal("forever"),
      reason: v.optional(v.string()),
    }),
  ]),
);

type Bans = v.InferOutput<typeof BansSchema>;

interface NormalBans extends Omit<Bans[], "created"> {
  created: Date;
}

export const OpConfigSchema = v.object({
  level: v.pipe(v.number(), v.minValue(0), v.maxValue(4)),
  bypassesPlayerLimit: v.boolean(),
});
const OpsSchema = v.array(v.intersect([WhitelistEntrySchema, OpConfigSchema]));

type Ops = v.InferOutput<typeof OpsSchema>;
type OpConfig = v.InferOutput<typeof OpConfigSchema>;

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

  private _whitelists = new Map<string, Whitelist>();
  private _ops = new Map<string, Ops>();
  private _bans = new Map<string, Bans>();
  private _properties = new Map<string, Properties>();

  closed;
  private completeClose: undefined | ((value?: unknown) => void);

  private logger = getLogger(["Shelf", "SettingsManager"]);

  getWhitelist(serverUUID: string) {
    return this._whitelists.get(serverUUID) ?? [];
  }

  getOps(serverUUID: string) {
    return this._ops.get(serverUUID) ?? [];
  }

  getBans(serverUUID: string) {
    return this._bans.get(serverUUID) ?? [];
  }

  getNormalizedBans(serverUUID: string) {
    return this.getBans(serverUUID).map((ban) => {
      // @ts-ignore We're converting the type here
      ban.created = parseMojDate(ban.created);
      return ban;
    }) as unknown as NormalBans[];
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

    this.closed = new Promise((resolve) => {
      this.completeClose = resolve;
    });

    (async () => {
      for await (const event of watcher) {
        this.handleEvent(event);
      }
    })().then(() => {
      this.logger.debug("Watcher has closed");
      this.completeClose?.();
    });
  }

  private updateAllServers() {
    this.logger.info("Updating all servers. This could clog the logs");

    for (const server of Deno.readDirSync(instancesPath)) {
      if (!server.isDirectory) continue;
      const uuid = server.name;

      this.updateWhitelist(uuid);
      this.updateOps(uuid);
      this.updateBans(uuid);
      try {
        this.updateProperties(uuid);
      } catch (err) {
        if (err === "not ready: server.properties") {
          this.logger.warn("Server UUID {uuid} has no properties yet", {
            uuid,
          });
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
        event.kind !== "access" ||
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

  private getPath(serverUUID: string, file: string) {
    const instancePath = join(instancesPath, serverUUID);
    if (!existsSync(instancePath)) throw "unknown: server";

    const filePath = join(instancePath, file);
    return filePath;
  }

  // Whitelist / whitelist.json

  private updateWhitelist(serverUUID: string) {
    this.logger.debug("Updating whitelist of Server UUID {serverUUID}", {
      serverUUID,
    });

    const whitelistPath = this.getPath(serverUUID, whitelistFile);

    try {
      const content = Deno.readTextFileSync(whitelistPath);
      const json = JSON.parse(content);
      const whitelist = v.parse(WhitelistSchema, json);
      this._whitelists.set(serverUUID, whitelist);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        // NotFound errors are not critical here
      } else if (err instanceof v.ValiError) {
        this.logger.error("Invalid Whitelist read");
      } else if (err instanceof Error) {
        this.logger.error("Error occured while reading Whitelist: {err}", {
          err,
        });
      } else {
        this.logger.error("Error occured while reading Whitelist");
      }
      this._whitelists.set(serverUUID, []);
    }
  }

  private saveWhitelist(serverUUID: string) {
    const whitelistPath = this.getPath(serverUUID, whitelistFile);
    const whitelist = this.getWhitelist(serverUUID);

    const content = JSON.stringify(whitelist);
    return Deno.writeTextFileSync(whitelistPath, content);
  }

  async addToWhitelist(serverUUID: string, playerName: string) {
    const entry = await getUUID(playerName);

    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      this.serverManager.write(serverUUID, `\nwhitelist add ${entry.name}\n`);
    } else {
      const whitelist = this.getWhitelist(serverUUID);

      whitelist.push(entry);

      this.saveWhitelist(serverUUID);
    }

    return entry;
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
    this.logger.debug("Updating ops of Server UUID {serverUUID}", {
      serverUUID,
    });

    const opsPath = this.getPath(serverUUID, opsFile);

    try {
      const content = Deno.readTextFileSync(opsPath);
      const json = JSON.parse(content);
      const ops = v.parse(OpsSchema, json);
      this._ops.set(serverUUID, ops);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        // NotFound errors are not critical here
      } else if (err instanceof v.ValiError) {
        this.logger.error("Invalid Ops read");
      } else if (err instanceof Error) {
        this.logger.error("Error occured while reading Ops: {err}", { err });
      } else {
        this.logger.error("Error occured while reading Ops");
      }

      this._ops.set(serverUUID, []);
    }
  }

  private saveOps(serverUUID: string) {
    const opsPath = this.getPath(serverUUID, opsFile);
    const ops = this.getOps(serverUUID);

    const content = JSON.stringify(ops);
    return Deno.writeTextFileSync(opsPath, content);
  }

  async addToOps(serverUUID: string, playerName: string) {
    const entry = await getUUID(playerName);

    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      this.serverManager.write(serverUUID, `\nop ${entry.name}\n`);
    } else {
      const ops = this.getOps(serverUUID);

      ops.push({ ...entry, bypassesPlayerLimit: false, level: 4 });

      this.saveOps(serverUUID);
    }

    return entry;
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

  modifyOp(serverUUID: string, uuid: string, config: Partial<OpConfig>) {
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

    return ops[idx];
  }

  // Bans / banned-players.json

  private updateBans(serverUUID: string) {
    this.logger.debug("Updating bans of Server UUID {serverUUID}", {
      serverUUID,
    });

    const bansPath = this.getPath(serverUUID, bansFile);

    try {
      const content = Deno.readTextFileSync(bansPath);
      const json = JSON.parse(content);
      const bans = v.parse(BansSchema, json);
      this._bans.set(serverUUID, bans);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        // NotFound errors are not critical here
      } else if (err instanceof v.ValiError) {
        this.logger.error("Invalid Bans read");
      } else if (err instanceof Error) {
        this.logger.error("Error occured while reading Bans: {err}", { err });
      } else {
        this.logger.error("Error occured while reading Bans");
      }
      this._bans.set(serverUUID, []);
    }
  }

  private saveBans(serverUUID: string) {
    const bansPath = this.getPath(serverUUID, bansFile);
    const bans = this.getBans(serverUUID);

    const content = JSON.stringify(bans);
    return Deno.writeTextFileSync(bansPath, content);
  }

  async banPlayer(serverUUID: string, playerName: string, reason?: string) {
    const entry = await getUUID(playerName);

    if (this.serverManager.states.get(serverUUID) === ServerStates.Running) {
      const command = `ban ${entry.name} ${reason}`.trim();
      this.serverManager.write(serverUUID, `\n${command}\n`);
    } else {
      const bans = this.getBans(serverUUID);

      const created = convToMojDate(new Date());
      bans.push({
        ...entry,
        expires: "forever",
        reason,
        source: "Server",
        created,
      });

      this.saveBans(serverUUID);
    }

    return entry;
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
    this.logger.debug("Updating properties of Server UUID {serverUUID}", {
      serverUUID,
    });

    const propertiesPath = this.getPath(serverUUID, propertiesFile);

    try {
      const content = Deno.readTextFileSync(propertiesPath);

      const entries: [string, PropertyTypes][] = content
        .split("\n")
        .filter((line) => line.includes("=") && !line.startsWith("#"))
        .map((line) => line.split("=", 2))
        .map(([key, value]) => [key, parseProperty(value)]);
      const properties = Object.fromEntries(entries);

      this._properties.set(serverUUID, properties);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        this._properties.delete(serverUUID);
        throw "not ready: server.properties";
      } else if (err instanceof v.ValiError) {
        this.logger.error("Invalid Properties read");
      } else if (err instanceof Error) {
        this.logger.error("Error occured while reading Properties: {err}", {
          err,
        });
      } else {
        this.logger.error("Error occured while reading Properties");
      }
      this._properties.delete(serverUUID);
    }
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
    this.savePropertiesFile(serverUUID);
  }
}
