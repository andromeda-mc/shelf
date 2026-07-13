import { getLogger } from "@logtape/logtape";
import { FetchError, ofetch } from "ofetch";

interface UUIDResult {
  uuid: string;
  name: string;
}

interface UUIDEntry {
  id: string;
  name: string;
}

const logger = getLogger(["Shelf", "MinecraftAPI"]);

export async function getUUID(playerName: string): Promise<UUIDResult> {
  logger.trace("Getting player UUID for {playerName}", { playerName });

  const json = await ofetch<UUIDEntry>(
    "https://api.minecraftservices.com/minecraft/profile/lookup/name/" +
      playerName,
    { responseType: "json" },
  ).catch((err) => {
    if (err instanceof FetchError && err.status === 404) {
      throw "unknown: player";
    }
    throw err;
  });

  return { name: json.name, uuid: normalizeUUID(json.id) };
}

const uuidNormalizationPattern =
  /^(\w{8})-?(\w{4})-?(\w{4})-?(\w{4})-?(\w{12})$/gm;
const uuidNormalizationSubst = "$1-$2-$3-$4-$5";

export function normalizeUUID(input: string): string {
  return input.replace(uuidNormalizationPattern, uuidNormalizationSubst);
}
