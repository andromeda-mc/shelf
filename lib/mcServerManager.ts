import { join } from "@std/path";
import type { DatabaseManagement } from "./dbManagement.ts";
import { JavaFinder } from "./javas.ts";
import { loaders } from "./serverSoftwares.ts";
import { type ProcessConfig, ProcessMonitor } from "./processMonitor.ts";
import {
  ServerStates,
  ServerCreationInfo,
  ServerSettings,
} from "./static/mcServerManager.ts";
import { getLogger } from "@logtape/logtape";

const installerTempPath = "/tmp/andromeda-stall2-installer.jar";

export class ServerManager {
  private dbManager;
  private javaFinder;

  states = new Map<string, ServerStates>();
  processes = new Map<string, ProcessMonitor>();
  listeners = new Map<string, Set<WebSocket>>();

  onServerCrash: undefined | ((name: string) => void);
  onStateChange: undefined | ((uuid: string, state: ServerStates) => void);

  private logger = getLogger(["Shelf", "McServerManager"]);

  constructor(dbManager: DatabaseManagement, javaFinder: JavaFinder) {
    this.dbManager = dbManager;
    this.javaFinder = javaFinder;

    for (const server of Object.values(this.dbManager.servers)) {
      this.states.set(server.uuid, ServerStates.Stopped);
      this.listeners.set(server.uuid, new Set());
    }
  }

  async createServer(info: ServerCreationInfo) {
    const generatedInfo = this.dbManager.registerServer(info);
    const softwareInfo = loaders[info.software];

    if (softwareInfo.hasLoaderVersions && !info.software_version) {
      throw TypeError("Loader requires loader version");
    }

    this.logger.info(
      "Create server requested: Name {name} with {software} {software_version} on {mc_version}",
      { ...info },
    );

    try {
      const downloadUrl = await softwareInfo.produceDownloadUrl(
        info.mc_version,
        info.software_version,
      );
      this.logger.trace("Downloading {downloadUrl}", { downloadUrl });
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

        const java = this.javaFinder.latestJava;

        this.logger.trace("Starting installer {java} {args}", { java, args });
        const result = Deno.spawnAndWaitSync(java, {
          args,
          cwd: "/tmp",
        });

        if (!result.success) {
          this.logger.error("Installation failed. Status {status}", {
            status: result.code,
          });
          throw "installation: script failed";
        }

        const run_path = join(generatedInfo.instancePath, "run.sh");

        if (info.software === "Quilt") {
          launchScript = "-jar quilt-server-launch.jar";
        }

        try {
          const content = Deno.readTextFileSync(run_path);
          launchScript = content
            .split("\n")
            .find((line) => line.startsWith("java"))!
            .replace("java", "")
            .replace("@user_jvm_args.txt", "");
          Deno.removeSync(run_path);
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
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
      this.listeners.set(generatedInfo.uuid, new Set());

      this.dbManager.sync();
      return generatedInfo.settings;
    } catch (e: unknown) {
      this.dbManager.deleteServer(generatedInfo.uuid);
      this.dbManager.sync();

      throw e;
    }
  }

  deleteServer(uuid: string) {
    this.logger.info("Deleting server {uuid}", { uuid });
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

    this.logger.info("Starting server {uuid}", { uuid });
    const serverMetadata = this.dbManager.getServer(uuid);
    const javaBin = await this.javaFinder.getJavaRuntimeForVersion(
      serverMetadata.mc_version,
    );

    const args: string[] = [
      "-Xms512M",
      `-Xmx${serverMetadata.maxMemory}M`,
      ...serverMetadata.launchOptions,
    ];

    const config: ProcessConfig = {
      bin: javaBin,
      args,
      cwd: this.dbManager.getInstancePath(uuid),
      customTerminate: loaders[serverMetadata.software].customTerminate,
    };

    const watcher = new ProcessMonitor(config);

    watcher.addListener((output) => {
      const msg = JSON.stringify({ data: "live-log", uuid, output });

      this.listeners.get(uuid)!.forEach((socket) => socket.send(msg));

      if (output.includes("This crash report has been saved to")) {
        this.logger.warn("Server {uuid} seems to have crashed", { uuid });
        const server = this.dbManager.getServer(uuid);
        this.onServerCrash?.(server.name);
        this.states.set(uuid, ServerStates.Stopped);
        return;
      }

      if (output.includes("Stopping server")) {
        this.logger.info("Server {uuid} is stopping", { uuid });
        this.states.set(uuid, ServerStates.Stopping);
        this.onStateChange?.(uuid, ServerStates.Stopping);
      } else if (output.includes('For help, type "help"')) {
        this.logger.info("Server {uuid} is running", { uuid });
        this.states.set(uuid, ServerStates.Running);
        this.onStateChange?.(uuid, ServerStates.Running);
      }
    });

    this.states.set(uuid, ServerStates.Starting);
    this.onStateChange?.(uuid, ServerStates.Starting);

    this.processes.set(uuid, watcher);

    watcher.process.status.then((v) => {
      const prevState = this.states.get(uuid);
      this.logger.info("Server {uuid} has stopped", { uuid });
      this.states.set(uuid, ServerStates.Stopped);
      this.onStateChange?.(uuid, ServerStates.Stopped);

      // The other crash detector sets the state to stopped.
      // If the server is already stopped (e.g. due to a crash) no second crash will be reported
      if (!v.success && prevState !== ServerStates.Stopped) {
        this.logger.warn("Server {uuid} seems to have crashed", { uuid });
        this.onServerCrash?.(serverMetadata.name);
      }
    });
  }

  stopServer(uuid: string) {
    if (!this.states.has(uuid)) {
      throw "unknown: server";
    }

    if (this.states.get(uuid) !== ServerStates.Running) {
      throw "server: not running";
    }
    this.logger.info("Stopping server {uuid}", { uuid });
    const watcher = this.processes.get(uuid)!;
    return watcher.terminate();
  }

  terminateServer(uuid: string) {
    if (!this.states.has(uuid)) {
      throw "unknown: server";
    }

    if (this.states.get(uuid) === ServerStates.Stopped) {
      throw "server: is stopped";
    }
    this.logger.info("Terminating server {uuid}", { uuid });
    const watcher = this.processes.get(uuid)!;
    return watcher.kill();
  }

  listAllServers() {
    return Object.values(this.dbManager.servers);
  }

  listAllVisibleServers(userUUID: string) {
    const servers = this.listAllServers();

    return servers.filter((server) => this.checkAccess(server, userUUID));
  }

  addServerListener(serverUUID: string, socket: WebSocket) {
    const listener = this.listeners.get(serverUUID);
    if (!listener) throw "unknown: server";
    listener.add(socket);
  }

  removeServerListener(serverUUID: string, socket: WebSocket) {
    const listener = this.listeners.get(serverUUID);
    if (!listener) throw "unknown: server";
    listener.delete(socket);
  }

  removeServerListeners(socket: WebSocket) {
    this.listeners.values().forEach((set) => set.delete(socket));
  }

  write(serverUUID: string, text: string) {
    if (this.states.get(serverUUID) === ServerStates.Stopped) {
      throw "server: is stopped";
    }

    this.processes.get(serverUUID)!.write(text);
  }
}
