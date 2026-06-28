import { command } from "./lib/server/decorators.ts";
import { log, Message, MessageData, Server } from "./lib/server/wsServer.ts";
import {
  API_VERSION,
  DatabaseManagement,
  Permissions,
} from "./lib/dbManagement.ts";
import { QueueManager } from "./lib/queueManager.ts";
import { JavaFinder } from "./lib/javas.ts";
import { ServerCreationInfo, ServerManager } from "./lib/mcServerManager.ts";
import { loaders } from "./lib/serverSoftwares.ts";

const publicCommands = ["version", "auth"];

class MainServer extends Server {
  /** key represents connUUID, value represents the UUID of an user */
  userMap = new Map<string, string | undefined>();
  authedUsers = new Set<WebSocket>();
  private dbManager;
  private queueManager;
  private serverManager;

  constructor(
    dbManager: DatabaseManagement,
    queueManager: QueueManager,
    serverManager: ServerManager,
  ) {
    super();
    this.dbManager = dbManager;
    this.queueManager = queueManager;
    this.serverManager = serverManager;
  }

  messagePreprocess(message: Message): boolean | undefined {
    // Authed check
    const userUUID = this.userMap.get(message.connUUID);
    if (!publicCommands.includes(message.command) && !userUUID) {
      return message.respondWithException("auth: not authed");
    }
    return;
  }

  onClose(instance: WebSocket, connUUID: string): void {
    this.userMap.delete(connUUID);
    this.authedUsers.delete(instance);
  }

  messageAll(msg: MessageData) {
    for (const instance of this.authedUsers) {
      this.send(instance, msg);
    }
  }

  @command("version")
  returnVersion(message: Message) {
    return message.respond({ data: "api_version", version: API_VERSION });
  }

  @command("auth")
  handleAuth(message: Message) {
    const { username, password } = message.content;
    if (typeof username !== "string" || typeof password !== "string") {
      return message.respondWithException("invalid: msg");
    }

    const user = this.dbManager.findUserByUsername(username);
    if (!user) {
      return message.respondWithException("auth: unknown user");
    }

    const success = this.dbManager.validateLoginHash(password, user.uuid);
    if (!success) {
      return message.respondWithException("auth: failed");
    }

    this.userMap.set(message.connUUID, user.uuid);
    this.authedUsers.add(message.instance);
    return message.respond({ data: "welcome" });
  }

  @command("create-server")
  createServer(message: Message) {
    const userUUID = this.userMap.get(message.connUUID)!;
    if (!this.dbManager.hasUserPermission(userUUID, Permissions.CreateServer)) {
      return message.respondWithException("auth: no permission");
    }

    const info: ServerCreationInfo = message.content;

    if (
      typeof info.name !== "string" ||
      !(info.software in loaders) ||
      typeof info.mc_version !== "string" ||
      (info.software_version !== undefined && typeof info.software_version !== "string")
    ) {
      return message.respondWithException("invalid: msg");
    }

    const promise = this.serverManager.createServer(info);

    this.queueManager.scheduleTask({
      title: "Creating server " + name,
      type: "Server creation",
      description: `${info.software} ${info.software_version} for ${info.mc_version}`,
      promise,
      notifyOnFinish: true,
    });
  }
}

if (import.meta.main) {
  log("StartUp", "Initialising DatabaseManager...");
  const dbManager = new DatabaseManagement();

  log("StartUp", "Initialising QueueManager...");
  const queueManager = new QueueManager();

  log("StartUp", "Initialising JavaFinder...");
  const javas = new JavaFinder(dbManager);

  log("StartUp", "Initialising ServerManager...");
  const serverManager = new ServerManager(dbManager, javas);

  log("StartUp", "Initialising MainServer...");
  const server = new MainServer(dbManager, queueManager, serverManager);

  queueManager.onQueueAdded = (task) => {
    server.messageAll({ data: "queue_new_task", task });
  };
  queueManager.onNotificationAdded = (notification) => {
    server.messageAll({ data: "queue_new_notification", notification });
  };

  log("StartUp", "Starting MainServer...");
  server.serve();
}
