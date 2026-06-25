import { command } from "./lib/server/decorators.ts";
import { log, Message, MessageData, Server } from "./lib/server/wsServer.ts";
import {
  API_VERSION,
  DatabaseManagement as DatabaseManager,
} from "./lib/dbManagement.ts";
import { QueueManager } from "./lib/queueManager.ts";
import { JavaFinder } from "./lib/javas.ts";

const publicCommands = ["version", "auth"];

class MainServer extends Server {
  /** key represents connUUID, value represents the UUID of an user */
  userMap = new Map<string, string | undefined>();
  authedUsers = new Set<WebSocket>();

  messagePreprocess(message: Message): boolean | undefined {
    // Authed check
    const userUUID = this.userMap.get(message.connUUID);
    if (!publicCommands.includes(message.command) && !userUUID) {
      return message.responseWithException("auth: not authed");
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
    return message.response({ data: "api_version", version: API_VERSION });
  }

  @command("auth")
  handleAuth(message: Message) {
    const { username, password } = message.content;
    if (typeof username !== "string" || typeof password !== "string") {
      return message.response({ data: "exception", msg: "invalid: msg" });
    }

    const user = dbManager.findUserByUsername(username);
    if (!user) {
      return message.response({ data: "exception", msg: "auth: unknown user" });
    }

    const success = dbManager.validateLoginHash(password, user.uuid);
    if (!success) {
      return message.response({ data: "exception", msg: "auth: failed" });
    }

    this.userMap.set(message.connUUID, user.uuid);
    this.authedUsers.add(message.instance);
    return message.response({ data: "welcome" });
  }
}

log("StartUp", "Initialising MainServer...");
export const server = new MainServer();

log("StartUp", "Initialising DatabaseManager...");
export const dbManager = new DatabaseManager();

log("StartUp", "Initialising QueueManager...");
export const queueManager = new QueueManager(
  (task) => {
    server.messageAll({ data: "queue_new_task", task });
  },
  (notification) => {
    server.messageAll({ data: "queue_new_notification", notification });
  },
);

log("StartUp", "Initialising JavaFinder...");
export const javas = new JavaFinder();

log("StartUp", "Starting MainServer...");
server.serve();
