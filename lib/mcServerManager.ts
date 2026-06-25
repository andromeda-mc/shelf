import { ServerSoftwares } from "./serverSoftwares.ts";

export interface ServerSettings {
  name: string; // user generated
  description: string; // user generated

  software: ServerSoftwares;
  software_version?: string;
  mc_version: string;

  autostart: boolean;
  autorestart: boolean;
  icon: string; // Either specified icon library or path to user uploaded image
}
