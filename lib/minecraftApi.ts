import { getLogger } from "@logtape/logtape";

interface UUIDResult {
  uuid: string;
  name: string;
}

const logger = getLogger(["Shelf", "MinecraftAPI"]);

export async function getUUID(playerName: string): Promise<UUIDResult> {
  logger.trace("Getting player UUID for {playerName}", { playerName });

  const response = await fetch(
    "https://api.minecraftservices.com/minecraft/profile/lookup/name/" +
      playerName,
  );

  if (response.status !== 200) {
    throw "unknown: player";
  }

  const json = await response.json();
  json.uuid = json.id;
  delete json["id"];

  return json;
}
