import { join } from "@std/path";
import type { DatabaseManagement, PermissionLevel } from "./dbManagement.ts";
import { JavaFinder } from "./javas.ts";
import { loaders, ServerSoftwares } from "./serverSoftwares.ts";
import { existsSync } from "@std/fs";
import { ProcessMonitor } from "./processMonitor.ts";

const installerTempPath = "/tmp/andromeda-stall2-installer.jar";

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

export class ServerManager {
  private dbManager;
  private javaFinder;

  states = new Map<string, ServerStates>();
  processes = new Map<string, ProcessMonitor>();

  constructor(dbManager: DatabaseManagement, javaFinder: JavaFinder) {
    this.dbManager = dbManager;
    this.javaFinder = javaFinder;

    for (const server of Object.values(this.dbManager.servers)) {
      this.states.set(server.uuid, ServerStates.Stopped);
    }
  }

  async createServer(info: ServerCreationInfo) {
    const generatedInfo = this.dbManager.registerServer(info);
    const softwareInfo = loaders[info.software];

    if (softwareInfo.hasLoaderVersions && !info.software_version) {
      throw TypeError("Loader requires loader version");
    }

    try {
      const downloadUrl = await softwareInfo.produceDownloadUrl(
        info.mc_version,
        info.software_version,
      );
      const response = await fetch(downloadUrl);
      const data = await response.bytes();

      let launchScript: string | undefined;

      if (softwareInfo.wantsToBeInstalled) {
        Deno.writeFileSync(installerTempPath, data);

        const args = [
          "-jar",
          installerTempPath,
          ...softwareInfo.installArgs!.map((a) =>
            a
              .replaceAll("%mc_version%", info.mc_version)
              .replaceAll("%loader_version%", info.software_version!)
              .replaceAll("%install%", generatedInfo.instancePath),
          ),
        ];

        const installer = new Deno.Command(this.javaFinder.latestJava, {
          args,
          cwd: "/tmp",
        }).spawn();

        const result = await installer.status;
        if (!result) {
          throw Error("Installation failed");
        }

        const run_path = join(generatedInfo.instancePath, "run.sh");

        if (info.software === "Quilt") {
          launchScript = "-jar quilt-server-launch.jar";
        } else if (existsSync(run_path)) {
          launchScript = Deno.readTextFileSync(run_path)
            .split("\n")
            .find((line) => line.startsWith("java"))!
            .replace("java", "")
            .replace("@user_jvm_args.txt", "");
          Deno.removeSync(run_path);
        }

        Deno.removeSync(installerTempPath);
      } else {
        Deno.writeFileSync(
          join(generatedInfo.instancePath, "server.jar"),
          data,
        );
      }

      // Hint: Add args like -Xmx2G between the java path and the launchScript
      if (!launchScript) {
        launchScript = "-jar server.jar";
      }

      generatedInfo.settings.launchOptions = launchScript
        .replace('"$@"', "")
        .trim()
        .split(" ");

      // Accept the EULA. A disclaimer has to be shown to the user before creation
      Deno.writeTextFileSync(
        join(generatedInfo.instancePath, "eula.txt"),
        "eula=true",
      );

      generatedInfo.settings.launchOptions.push("nogui");
      this.states.set(generatedInfo.uuid, ServerStates.Stopped);

      this.dbManager.sync();
      return generatedInfo.settings;
    } catch (e: unknown) {
      this.dbManager.deleteServer(generatedInfo.uuid);
      this.dbManager.sync();

      throw e;
    }
  }

  deleteServer(uuid: string) {
    this.dbManager.deleteServer(uuid);
    this.dbManager.sync();
  }

  isUserAllowedToAccessServer(userUUID: string, serverUUID: string): boolean {
    if (!this.states.has(serverUUID)) {
      throw "unknown: server";
    }
    const serverMetadata = this.dbManager.getServer(serverUUID);
    return this.checkAccess(serverMetadata, userUUID);
  }

  private checkAccess(server: ServerSettings, userUUID: string) {
    if (server.userWhitelist.includes(userUUID)) return true;

    return this.dbManager.hasUserPermissionLevel(
      userUUID,
      server.visibilityLevel,
    );
  }

  async startServer(uuid: string) {
    if (!this.states.has(uuid)) {
      throw "unknown: server";
    }

    if (this.states.get(uuid) !== ServerStates.Stopped) {
      throw "invalid: already running";
    }

    const serverMetadata = this.dbManager.getServer(uuid);
    const javaBin = await this.javaFinder.getJavaRuntimeForVersion(
      serverMetadata.mc_version,
    );

    const args: string[] = [
      "-Xms512M",
      `-Xmx${serverMetadata.maxMemory}M`,
      ...serverMetadata.launchOptions,
    ];

    const watcher = new ProcessMonitor(
      javaBin,
      args,
      this.dbManager.getInstancePath(uuid),
    );

    // Test: Dump output to console
    const encoder = new TextEncoder();
    watcher.addListener((output) => {
      Deno.stdout.write(encoder.encode(output));
    });

    this.states.set(uuid, ServerStates.Starting);
    this.processes.set(uuid, watcher);
  }

  stopServer(uuid: string) {
    if (!this.states.has(uuid)) {
      throw "unknown: server";
    }

    // if (this.states.get(uuid) !== ServerStates.Running) {
    //   throw new Error("Server is not running");
    // }
    const watcher = this.processes.get(uuid)!;
    return watcher.terminate();
  }

  listAllServers() {
    return Object.values(this.dbManager.servers);
  }

  listAllVisibleServers(userUUID: string) {
    const servers = this.listAllServers();

    return servers.filter((server) => this.checkAccess(server, userUUID));
  }
}
