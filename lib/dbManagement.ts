import { generate as generateUUID } from "@std/uuid/v7";
import { hash, verify } from "@bronti/argon2";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { ServerCreationInfo, ServerSettings } from "./mcServerManager.ts";

export const API_VERSION = 2;

const rootPath = join(Deno.env.get("HOME") ?? "home", ".var/andromeda/stall2");
const globalDBPath = join(rootPath, "global-db.json");
const instancesPath = join(rootPath, "instances");

export enum PermissionLevel {
  Visitor,
  User,
  Admin,
}

export enum Permissions {
  CreateServer = "create-server",
  StartServer = "start-server",
  StopServer = "stop-server",
  KillServer = "kill-server",
}

const defaultPermissions: Record<Permissions, boolean> = {
  "create-server": false,
  "start-server": false,
  "stop-server": false,
  "kill-server": false,
};

interface UserData {
  uuid: string;
  name: string;
  loginHash: string;
  locked: boolean;

  permissionLevel: PermissionLevel;
  permissions: Record<Permissions, boolean>;
}

interface GlobalDBData {
  version: number;
  users: Record<string, UserData>;
  servers: Record<string, ServerSettings>;
  additionalJavaPaths: string[];
}

export class DatabaseManagement {
  globalDB: GlobalDBData;

  constructor() {
    Deno.mkdirSync(rootPath, { recursive: true });
    if (!existsSync(globalDBPath)) {
      this.globalDB = {
        version: API_VERSION,
        users: {},
        servers: {},
        additionalJavaPaths: [],
      };

      const adminUUID = this.createUser("admin", hash("change-me"));
      this.globalDB.users[adminUUID].permissionLevel = PermissionLevel.Admin;

      this.sync();
    } else {
      const content = Deno.readTextFileSync(globalDBPath);
      this.globalDB = JSON.parse(content);
    }
  }

  // Users

  createUser(name: string, loginHash: string) {
    const uuid = generateUUID();

    this.globalDB.users[uuid] = {
      uuid,
      loginHash,
      locked: false,
      name,
      permissionLevel: PermissionLevel.User,
      permissions: Object.assign({}, defaultPermissions),
    };
    return uuid;
  }

  findUserByUsername(username: string) {
    return Object.values(this.globalDB.users).find((v) => v.name === username);
  }

  hasUserPermission(uuid: string, permission: Permissions) {
    const user = this.globalDB.users[uuid];

    if (user.permissionLevel === PermissionLevel.Visitor) return false;
    if (user.permissionLevel === PermissionLevel.Admin) return true;
    return user.permissions[permission];
  }

  sync() {
    Deno.writeTextFileSync(globalDBPath, JSON.stringify(this.globalDB));
  }

  validateLoginHash(password: string, uuid: string) {
    const user = this.globalDB.users[uuid];
    return verify(password, user.loginHash);
  }

  // Servers

  registerServer({
    name,
    software,
    software_version,
    mc_version,
  }: ServerCreationInfo) {
    const uuid = generateUUID();
    const instancePath = join(instancesPath, uuid);

    Deno.mkdirSync(instancePath, { recursive: true });

    const settings: ServerSettings = {
      name,
      description: "",
      uuid,

      software,
      software_version,
      mc_version,

      launchOptions: [],
      autostart: false,
      autorestart: false,
      maxMemory: 2048,
      icon: "grass",
      creationDate: new Date().toISOString(),
    };
    this.globalDB.servers[uuid] = settings;

    return { uuid, instancePath, settings };
  }

  deleteServer(uuid: string) {
    if (!(uuid in this.globalDB.servers)) return false;
    const instancePath = join(instancesPath, uuid);

    Deno.removeSync(instancePath, { recursive: true });
    return delete this.globalDB.servers[uuid];
  }

  get servers() {
    return this.globalDB.servers;
  }

  getServer(uuid: string) {
    return this.globalDB.servers[uuid];
  }

  getInstancePath(uuid: string) {
    return join(instancesPath, uuid);
  }
}
