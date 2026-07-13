import { getLogger } from "@logtape/logtape";
import { FetchError, ofetch } from "ofetch";

interface UUIDResult {
  uuid: string;
  name: string;
}

const logger = getLogger(["Shelf", "MinecraftAPI"]);

export async function getUUID(playerName: string): Promise<UUIDResult> {
  logger.trace("Getting player UUID for {playerName}", { playerName });

  const json = await ofetch(
    "https://api.minecraftservices.com/minecraft/profile/lookup/name/" +
      playerName,
    { responseType: "json" },
  ).catch((err) => {
    if (err instanceof FetchError && err.status === 404) {
      throw "unknown: player";
    }
    throw err;
  });

  json.uuid = json.id;
  delete json["id"];

  return json;
}
