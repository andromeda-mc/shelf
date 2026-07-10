import { existsSync } from "@std/fs/exists";
import { join } from "@std/path/join";

export const rootPath = join(Deno.env.get("HOME") ?? "home", ".var/andromeda/stall2");
export const globalDBPath = join(rootPath, "global-db.json");
export const instancesPath = join(rootPath, "instances");
export const iconRootPath = existsSync("icons") ? "icons" : join(rootPath, "icons");

export enum PermissionLevel {
  Visitor,
  User,
  Admin
}

export enum Permissions {
  CreateServer = "create-server",
  StartServer = "start-server",
  StopServer = "stop-server",
  KillServer = "kill-server",
  DeleteServer = "delete-server",

  ManageNotifications = "manage-notifications"
}
