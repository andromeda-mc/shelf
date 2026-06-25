import { join } from "@std/path";
import type { DatabaseManagement } from "./dbManagement.ts";
import { JavaFinder } from "./javas.ts";
import { loaders, ServerSoftwares } from "./serverSoftwares.ts";
import { existsSync } from "@std/fs";

const installerTempPath = "/tmp/installer.jar";

export interface ServerSettings {
  name: string; // user generated
  description: string; // user generated
  uuid: string;

  software: ServerSoftwares;
  software_version?: string;
  mc_version: string;

  launch_options: string[];
  autostart: boolean;
  autorestart: boolean;
  max_memory: number;
  icon: string; // Either specified icon library or path to user uploaded image
}

export interface ServerCreationInfo {
  name: string;
  software: ServerSoftwares;
  software_version?: string;
  mc_version: string;
}

export class ServerManager {
  private dbManager;
  private javaFinder;

  constructor(dbManager: DatabaseManagement, javaFinder: JavaFinder) {
    this.dbManager = dbManager;
    this.javaFinder = javaFinder;
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
        }).spawn();

        const result = await installer.status;
        if (!result) {
          throw Error("Installation failed");
        }

        const run_path = join(generatedInfo.instancePath, "run.sh");

        if (info.software === "Quilt") {
          launchScript = "@user_jvm_args.txt -jar quilt-server-launch.jar";
        } else if (existsSync(run_path)) {
          launchScript = Deno.readTextFileSync(run_path).replace("java", "");
          Deno.removeSync(run_path);
        }
      } else {
        Deno.writeFileSync(
          join(generatedInfo.instancePath, "server.jar"),
          data,
        );
      }

      if (!launchScript) {
        launchScript = "@user_jvm_args.txt -jar server.jar";
      }

      generatedInfo.settings.launch_options = launchScript
        .replace('"$@"', "")
        .trim()
        .split(" ");

      this.dbManager.syncGlobalDB();
    } catch (e: unknown) {
      this.dbManager.deleteServer(generatedInfo.uuid);
      this.dbManager.syncGlobalDB();

      throw e;
    }
  }
}
