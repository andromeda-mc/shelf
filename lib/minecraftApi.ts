interface UUIDResult {
  uuid: string;
  name: string;
}

export async function getUUID(playerName: string): Promise<UUIDResult> {
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
