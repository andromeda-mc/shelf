import type { MaybePromise } from "./utils/type.ts";

interface MultiMCVersion {
  releaseTime: string;
  requires: { equals: string; uid: string }[];
  sha256: string;
  version: string;
  recommended?: boolean;
}

interface MultiMCMetadata {
  formatVersion: number;
  name: string;
  uid: string;
  versions: MultiMCVersion[];
}

interface Loader {
  mcVersions: string[];
  indepdendantLoaderVersions?: string[];
  recommended: Record<string, string>;

  hasLoaderVersions: boolean;
  wantsToBeInstalled: boolean;
  installArgs?: string[];

  produceDownloadUrl(
    mcVersion: string,
    loaderVersion?: string,
  ): MaybePromise<string>;
  getLoaderVersionsForMC(mcVersion: string): MaybePromise<string[]>;
}

class MultiMCSoftwareData implements Loader {
  private uid: string;
  private downloadUrl: string;
  private metadata: MultiMCMetadata | undefined;

  mcVersions: string[] = [];
  private loaderVersions: Record<string, string[]> = {};
  recommended: Record<string, string> = {};

  hasLoaderVersions = true;
  wantsToBeInstalled = true;
  installArgs: string[];

  constructor(multiUid: string, downloadUrl: string, installArgs: string[]) {
    this.uid = multiUid;
    this.downloadUrl = downloadUrl;
    this.installArgs = installArgs;

    fetch("https://meta.multimc.org/v1/" + this.uid).then((resp) =>
      resp.json().then((json) => {
        this.metadata = json;
        this.produceVersionLists();
      }),
    );
  }

  private produceVersionLists() {
    if (!this.metadata) throw Error("No metadata available");

    this.mcVersions = [
      ...new Set(
        this.metadata.versions
          .map(
            (v) => v.requires!.find((r) => r.uid === "net.minecraft")?.equals,
          )
          .filter((v) => v !== undefined),
      ),
    ];

    for (const version of this.mcVersions) {
      // FIXME: NeoForge does not create a recommended list
      this.loaderVersions[version] = this.metadata.versions
        .filter((v) => v.requires!.some((r) => r.equals === version))
        .map((v) => v.version);

      const recVersion = this.metadata.versions.find(
        (v) => v.recommended && v.requires.some((r) => r.equals === version),
      );
      if (recVersion) this.recommended[version] = recVersion.version;
    }
  }

  produceDownloadUrl(mcVersion: string, loaderVersion: string): string {
    return this.downloadUrl
      .replaceAll("$ld", loaderVersion)
      .replaceAll("$mc", mcVersion);
  }

  getLoaderVersionsForMC(mcVersion: string): string[] {
    return this.loaderVersions[mcVersion];
  }
}

interface VanillaVersion {
  id: string;
  type: "snapshot" | "release" | "old_beta" | "old_alpha";
  url: string;
  time: string;
  releaseTime: string;
}

interface VanillaManifest {
  latest: { release: string; snapshot: string };
  versions: VanillaVersion[];
}

class VanillaSoftwareData implements Loader {
  private versionManifest: VanillaManifest | undefined = undefined;

  mcVersions: string[] = [];
  private loaderVersions = {};
  recommended: Record<string, string> = {};

  hasLoaderVersions = false;
  wantsToBeInstalled = false;

  constructor() {
    fetch("https://launchermeta.mojang.com/mc/game/version_manifest.json").then(
      (resp) =>
        resp.json().then((json) => {
          this.versionManifest = json;
          this.produceVersionLists();
        }),
    );
  }

  private produceVersionLists() {
    if (!this.versionManifest) throw Error("No metadata available");

    this.mcVersions = this.versionManifest.versions
      .filter((v) => v.type === "snapshot" || v.type === "release")
      .map((v) => v.id);

    this.recommended[this.versionManifest.latest.release] = "-";
    this.recommended[this.versionManifest.latest.snapshot] = "-";
  }

  async produceDownloadUrl(mcVersion: string): Promise<string> {
    if (!this.versionManifest) throw Error("No metadata available");

    const packageResponse = await fetch(
      this.versionManifest.versions.find((v) => v.id === mcVersion)!.url,
    );
    const packageMetadata = await packageResponse.json();

    if (!packageMetadata.downloads.server) throw Error("No download url found");
    return packageMetadata.downloads.server.url;
  }

  getLoaderVersionsForMC(): string[] {
    throw Error(
      "This is a Loader without LoaderVersions and this function shouldn't have been called",
    );
  }
}

interface FabricManifest {
  game: { version: string; stable: boolean }[];
  mappings: unknown[];
  intermediary: unknown[];
  loader: {
    separator: string;
    build: number;
    maven: string;
    version: string;
    stable?: boolean;
  }[];
  installer: { url: string; maven: string; version: string }[];
}

class FabricSoftwareData implements Loader {
  private manifest: FabricManifest | undefined = undefined;
  private installerVersion: string | undefined = undefined;
  private downloadUrl: string;

  mcVersions: string[] = [];
  indepdendantLoaderVersions: string[] = [];
  recommended: Record<string, string> = {};

  hasLoaderVersions = true;
  wantsToBeInstalled: boolean;
  installArgs: string[] | undefined;

  constructor(
    metaUrl: string,
    downloadUrl: string,
    wantsToBeInstalled: boolean,
    installArgs?: string[] | undefined,
  ) {
    this.wantsToBeInstalled = wantsToBeInstalled;
    this.installArgs = installArgs;
    this.downloadUrl = downloadUrl;

    fetch(metaUrl).then((resp) =>
      resp.json().then((json) => {
        this.manifest = json;
        this.produceVersionLists();
      }),
    );
  }

  private produceVersionLists() {
    if (!this.manifest) throw Error("No metadata available");
    this.installerVersion = this.manifest.installer[0].version;

    this.mcVersions = this.manifest.game.map((v) => v.version);
    this.indepdendantLoaderVersions = this.manifest.loader.map(
      (v) => v.version,
    );
  }

  produceDownloadUrl(mcVersion: string, loaderVersion: string): string {
    if (!this.installerVersion) throw Error("No metadata available");
    return this.downloadUrl
      .replaceAll("$mc", mcVersion)
      .replaceAll("$ld", loaderVersion)
      .replaceAll("$in", this.installerVersion);
  }

  getLoaderVersionsForMC(): string[] {
    throw Error(
      "This Loader has independant version numbers and this function shouldn't have been called",
    );
  }
}

interface PaperProjectMetadata {
  project: unknown;
  versions: Record<string, string[]>;
}

interface PaperBuildMetadata {
  version: { id: string; java: unknown };
  builds: number[];
}

class PaperSoftwareData implements Loader {
  private manifest: PaperProjectMetadata | undefined = undefined;

  mcVersions: string[] = [];
  recommended: Record<string, string> = {};

  wantsToBeInstalled = false;
  hasLoaderVersions = true;

  constructor() {
    fetch("https://fill.papermc.io/v3/projects/paper").then(async (resp) => {
      const json = await resp.json();
      this.manifest = json;
      this.produceVersionLists();
    });
  }

  private async produceVersionLists() {
    if (!this.manifest) throw new Error("No metadata available");
    this.mcVersions = Object.values(this.manifest.versions).flat();

    const response = await fetch(
      `https://fill.papermc.io/v3/projects/paper/versions/${this.mcVersions[0]}/builds/latest`,
    );
    const json = await response.json();
    this.recommended[this.mcVersions[0]] = json.id.toString();
  }

  async getLoaderVersionsForMC(mcVersion: string): Promise<string[]> {
    const response = await fetch(
      "https://fill.papermc.io/v3/projects/paper/versions/" + mcVersion,
    );
    const json: PaperBuildMetadata = await response.json();

    return json.builds.map((b) => b.toString());
  }

  async produceDownloadUrl(
    mcVersion: string,
    loaderVersion: string,
  ): Promise<string> {
    const response = await fetch(
      `https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds/${loaderVersion}`,
    );
    const buildMetadata = await response.json();

    if (!buildMetadata.downloads["server:default"])
      throw Error("No download url found");
    return buildMetadata.downloads["server:default"].url;
  }
}

export type ServerSoftwares =
  | "Vanilla"
  | "Forge"
  | "NeoForge"
  | "Quilt"
  | "Fabric"
  | "Paper";

export const loaders: Record<ServerSoftwares, Loader> = {
  // Installer
  Forge: new MultiMCSoftwareData(
    "net.minecraftforge",
    "https://maven.minecraftforge.net/net/minecraftforge/forge/$mc-$ld/forge-$mc-$ld-installer.jar",
    ["--installServer", "%install%"],
  ),
  NeoForge: new MultiMCSoftwareData(
    "net.neoforged",
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/$ld/neoforge-$ld-installer.jar",
    ["--install-server", "%install%"],
  ),
  Quilt: new FabricSoftwareData(
    "https://meta.quiltmc.org/v3/versions",
    "https://quiltmc.org/api/v1/download-latest-installer/java-universal",
    false,
    [
      "install",
      "server",
      "%mc_version%",
      "%loader_version%",
      "--install-dir=%install%",
      "--download-server"
    ],
  ),

  // Not-Installer
  Vanilla: new VanillaSoftwareData(),
  Fabric: new FabricSoftwareData(
    "https://meta.fabricmc.net/v2/versions",
    "https://meta.fabricmc.net/v2/versions/loader/$mc/$ld/$in/server/jar",
    true,
  ),
  Paper: new PaperSoftwareData(),
};
