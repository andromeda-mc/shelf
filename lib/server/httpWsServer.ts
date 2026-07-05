// deno-lint-ignore-file no-explicit-any
import { format } from "@std/datetime";
import { HandlerManager } from "./handlerManager.ts";
import { safeParse } from "@valibot/valibot";
import {
  DatabaseManagement,
  PermissionLevel,
  Permissions,
} from "../dbManagement.ts";

export function log(module: string, ...message: any[]) {
  const joinedMessage = message
    .map((m) => String(m))
    .join(" ")
    .replaceAll(/[\n\r]/gm, "");
  const timeStamp = format(new Date(), "yyyy.MM.dd HH:mm:ss");

  console.log(`${module} - [${timeStamp}] : ${joinedMessage} -`);
}

export type MessageData = { data: string } & Record<string, any>;

export interface ServerOptions {
  port: number;
  hostname: string;
}

const defaultServerOptions: ServerOptions = {
  port: 29836,
  hostname: "0.0.0.0",
};

export class HttpServer {
  handlerManager: HandlerManager;
  dbManager: DatabaseManagement;
  options: ServerOptions;

  private userMap = new Map<WebSocket, string>();

  constructor(
    handlerManager: HandlerManager,
    dbManager: DatabaseManagement,
    serverOptions: Partial<ServerOptions>,
  ) {
    this.dbManager = dbManager;
    this.handlerManager = handlerManager;
    this.options = Object.assign(defaultServerOptions, serverOptions);
  }

  serve() {
    Deno.serve(
      {
        ...this.options,
        onListen({ hostname, port }) {
          log("WS", `Andromeda Shelf listens on ws://${hostname}:${port}`);
        },
      },
      (req, conInfo) => {
        let hostname = "dummy";
        if (Object.keys(conInfo).length !== 0) {
          hostname = conInfo.remoteAddr.hostname;
        }

        if (req.method === "POST") {
          return this.handleHttpPostRequest(req);
        }

        if (req.headers.get("upgrade") !== "websocket") {
          return new Response(null, { status: 426 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);

        socket.addEventListener("open", () => {
          log("WS", hostname, "Open");
        });

        socket.addEventListener("close", () => {
          this.userMap.delete(socket);
          log("WS", hostname, "Close");
        });

        socket.addEventListener("message", (event) => {
          log("WS", hostname, "Message:", event.data);
          this.handleWebSocketCommand(socket, event);
        });

        return response;
      },
    );
  }

  protected handleHttpPostRequest(req: Request): Response {
    throw new Error("Not implemented - handleHttpPostRequest");
  }

  protected handleWebSocketCommand(socket: WebSocket, event: MessageEvent) {
    try {
      const msg = JSON.parse(event.data);
      const command = msg.data;

      if (!command) {
        this.errorWS(socket, "invalid: no data");
        log("WS", "Invalid message received: No command");
        return;
      }

      const error = (msg: string) => {
        this.errorWS(socket, msg, { responseTo: command });
      };

      if (!(command in this.handlerManager.wsHandlers)) {
        error("invalid: command");
        log("WS", "Unknown command:", command);
        return;
      }

      const entry = this.handlerManager.wsHandlers[command];
      const options: Record<any, any> = {};

      const userUUID = this.userMap.get(socket);

      if (
        !(
          userUUID ||
          entry.flags.includes("public") ||
          entry.flags.includes("force-public")
        )
      ) {
        error("auth: not authed");
        log("WS", "Unauthorized user");
        return;
      }

      if (userUUID && entry.flags.includes("force-public")) {
        error("auth: authed users disallowed");
        log("WS", "Authorized users disallowed");
        return;
      }

      options.userUUID = userUUID;

      for (const flag of entry.flags) {
        // @ts-ignore we're checking if it is a Permission
        if (Object.values(Permissions).includes(flag) && userUUID) {
          if (
            !this.dbManager.hasUserPermission(userUUID, flag as Permissions)
          ) {
            error("auth: no permission");
            log("WS", "Unauthorized user. No permission");
            return;
          }
        } else if (flag in PermissionLevel && userUUID) {
          if (
            this.dbManager.hasUserPermissionLevel(
              userUUID,
              flag as PermissionLevel,
            )
          ) {
            error("auth: no permission");
            log("WS", "Unauthorized user. No permission level");
            return;
          }
        }
      }

      if (entry.schema) {
        const parseResult = safeParse(entry.schema, msg);

        if (!parseResult.success) {
          const issues = parseResult.issues.map((i) => i.message).join("; ");

          error("validation: " + issues);
          log("WS", "Handler found, but schema failed:", issues);
          return;
        }

        options.data = parseResult.output;
      }

      options.respond = (data: MessageData) => {
        this.sendWS(socket, { ...data, responseTo: command });
      };

      options.authConnection = (userUUID: string) => {
        this.userMap.set(socket, userUUID);
      };

      try {
        entry.handler(options);
      } catch (err) {
        if (typeof err === "string") {
          error(err);
        } else {
          error("failed: execution");
          log("WS", `Error in handler '${command}': ${err}`);
        }
      }
    } catch (err) {
      this.errorWS(socket, "invalid: msg");
      log("WS", "Invalid message received: " + err);
    }
  }

  sendWS(socket: WebSocket, data: MessageData) {
    socket.send(JSON.stringify(data));
  }

  sendAllWS(data: MessageData) {
    for (const socket of this.userMap.keys()) {
      this.sendWS(socket, data);
    }
  }

  errorWS(
    socket: WebSocket,
    msg: string,
    additionalData?: Record<string, any>,
  ) {
    return this.sendWS(socket, { data: "exception", msg, ...additionalData });
  }
}
