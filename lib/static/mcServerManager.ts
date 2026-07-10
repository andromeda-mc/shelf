import type { ServerSoftwares } from "../serverSoftwares.ts";
import type { PermissionLevel } from "./dbManager.ts";

export interface ServerSettings {
  name: string; // user generated
  description: string; // user generated
  uuid: string;

  software: ServerSoftwares;
  software_version?: string;
  mc_version: string;

  launchOptions: string[];
  autostart: boolean;
  autorestart: boolean;
  maxMemory: number;
  icon: string; // Either specified icon library or path to user uploaded image
  creationDate: string; // ISO

  visibilityLevel: PermissionLevel; // Minimum Permission Level to see this server
  userWhitelist: string[]; // Additional allowed user UUIDs
}

export interface ServerCreationInfo {
  name: string;
  software: ServerSoftwares;
  software_version?: string;
  mc_version: string;
}

export enum ServerStates {
  Stopped = "stopped",
  Starting = "starting",
  Running = "running",
  Stopping = "stopping",
}
