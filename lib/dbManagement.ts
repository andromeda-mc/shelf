import { JWTPayload, jwtVerify, SignJWT } from "jose";
import { generate as generateUUID } from "@std/uuid/v7";
import { hash, verify } from "@bronti/argon2";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { ServerCreationInfo, ServerSettings } from "./mcServerManager.ts";
import * as v from "@valibot/valibot";
import * as vars from "./vars.ts";

const rootPath = join(Deno.env.get("HOME") ?? "home", ".var/andromeda/stall2");
const globalDBPath = join(rootPath, "global-db.json");
const instancesPath = join(rootPath, "instances");
const iconRootPath = existsSync("icons") ? "icons" : join(rootPath, "icons");

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
  DeleteServer = "delete-server",

  ManageNotifications = "manage-notifications",
}

const defaultPermissions: Record<Permissions, boolean> = {
  "create-server": false,
  "start-server": true,
  "stop-server": false,
  "kill-server": false,
  "delete-server": false,
  "manage-notifications": false,
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

const JWTTokenSchema = v.object({
  tokenType: v.literal("httpAuth"),
  userUUID: v.pipe(v.string(), v.uuid()),
});
type JWTToken = v.InferOutput<typeof JWTTokenSchema>;

export class DatabaseManagement {
  globalDB: GlobalDBData;
  jwtToken = new TextEncoder().encode(generateUUID());

  constructor() {
    Deno.mkdirSync(rootPath, { recursive: true });
    if (!existsSync(globalDBPath)) {
      this.globalDB = {
        version: vars.API_VERSION,
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

  userExists(uuid: string): boolean {
    return uuid in this.globalDB.users;
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

  hasUserPermissionLevel(uuid: string, level: PermissionLevel) {
    const user = this.globalDB.users[uuid];
    return level >= user.permissionLevel;
  }

  sync() {
    Deno.writeTextFileSync(globalDBPath, JSON.stringify(this.globalDB));
  }

  validateLoginHash(password: string, uuid: string) {
    const user = this.globalDB.users[uuid];
    return verify(password, user.loginHash);
  }

  // JWT Logic for HTTP Requests

  async generateJWT(userUUID: string): Promise<string | undefined> {
    if (!this.userExists(userUUID)) return;

    return await new SignJWT({ tokenType: "httpAuth", userUUID } as JWTToken &
      JWTPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10 mins")
      .sign(this.jwtToken);
  }

  async validateJWT(token: string): Promise<string | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.jwtToken);
      const result = v.safeParse(JWTTokenSchema, payload);

      if (!result.success) return;

      const { userUUID } = result.output;

      if (!this.userExists(userUUID)) return;

      return userUUID;
    } catch {
      return;
    }
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

      visibilityLevel: PermissionLevel.Admin,
      userWhitelist: [],
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

  // Misc

  getIconPath(icon: string) {
    return join(iconRootPath, icon + ".png");
  }
}
