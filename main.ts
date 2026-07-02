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
import * as v from "@valibot/valibot";
import { promissify } from "./lib/utils/promises.ts";

const AuthSchema = v.object({
  username: v.string(),
  password: v.string(),
});

const CreateServerSchema = v.object({
  name: v.string(),
  software: v.pipe(
    v.string(),
    v.check((item) => item in loaders),
  ),
  mc_version: v.string(),
  software_version: v.undefinedable(v.string()),
});

const SimpleServerActionSchema = v.object({
  uuid: v.pipe(v.string(), v.uuid()),
});

const publicCommands = ["version", "auth"];

class MainServer extends Server {
  /** key represents connUUID, value represents the UUID of an user */
  userMap = new Map<WebSocket, string | undefined>();
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
    const userUUID = this.userMap.get(message.instance);
    if (!publicCommands.includes(message.command) && !userUUID) {
      return message.respondWithException("auth: not authed");
    }
    return;
  }

  onClose(instance: WebSocket): void {
    this.userMap.delete(instance);
  }

  messageAll(msg: MessageData) {
    for (const instance of this.userMap.keys()) {
      this.send(instance, msg);
    }
  }

  @command("version")
  returnVersion(message: Message) {
    return message.respond({ data: "api_version", version: API_VERSION });
  }

  @command("auth")
  handleAuth(message: Message) {
    const result = v.safeParse(AuthSchema, message.content);
    if (!result.success) {
      return message.respondWithException("validation: " + result.issues);
    }

    const user = this.dbManager.findUserByUsername(result.output.username);
    if (!user) {
      return message.respondWithException("auth: unknown user");
    }

    const success = this.dbManager.validateLoginHash(
      result.output.password,
      user.uuid,
    );
    if (!success) {
      return message.respondWithException("auth: failed");
    }

    this.userMap.set(message.instance, user.uuid);
    return message.respond({ data: "welcome" });
  }

  @command("create-server")
  createServer(message: Message) {
    const userUUID = this.userMap.get(message.instance)!;
    if (!this.dbManager.hasUserPermission(userUUID, Permissions.CreateServer)) {
      return message.respondWithException("auth: no permission");
    }

    const result = v.safeParse(CreateServerSchema, message.content);
    if (!result.success) {
      return message.respondWithException("validation: " + result.issues);
    }

    const info = result.output as ServerCreationInfo;
    const promise = this.serverManager.createServer(info);

    this.queueManager.scheduleTask({
      title: "Creating server " + name,
      type: "Server creation",
      description: `${info.software} ${info.software_version} for ${info.mc_version}`,
      promise,
      notifyOnFinish: true,
    });
  }

  @command("start-server")
  startServer(message: Message) {
    const userUUID = this.userMap.get(message.instance)!;
    if (!this.dbManager.hasUserPermission(userUUID, Permissions.StartServer)) {
      return message.respondWithException("auth: no permission");
    }

    const result = v.safeParse(SimpleServerActionSchema, message.content);
    if (!result.success) {
      return message.respondWithException("validation: " + result.issues);
    }

    const { uuid } = result.output;
    const info = this.dbManager.getServer(uuid);
    const promise = this.serverManager.startServer(uuid);

    this.queueManager.scheduleTask({
      title: "Starting server " + info.name,
      type: "Server starting",
      promise,
      notifyOnFinish: false,
    });
  }

  @command("stop-server")
  stopServer(message: Message) {
    const userUUID = this.userMap.get(message.instance)!;
    if (!this.dbManager.hasUserPermission(userUUID, Permissions.StopServer)) {
      return message.respondWithException("auth: no permission");
    }

    const result = v.safeParse(SimpleServerActionSchema, message.content);
    if (!result.success) {
      return message.respondWithException("validation: " + result.issues);
    }

    const { uuid } = result.output;
    const info = this.dbManager.getServer(uuid);
    const promise = promissify(() => {
      this.serverManager.stopServer(uuid);
    });

    this.queueManager.scheduleTask({
      title: "Stopping server " + info.name,
      type: "Server stopping",
      promise,
      notifyOnFinish: false,
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
  queueManager.onQueueRemoved = (taskUUID) => {
    server.messageAll({ data: "queue_remove_task", taskUUID });
  };
  queueManager.onNotificationAdded = (notification) => {
    server.messageAll({ data: "queue_new_notification", notification });
  };

  log("StartUp", "Starting MainServer...");
  server.serve();
}
