// deno-lint-ignore-file no-explicit-any
import { format } from "@std/datetime";
import { HandlerManager } from "./handlerManager.ts";
import { safeParse } from "@valibot/valibot";
import { DatabaseManagement } from "../dbManagement.ts";
import { PermissionLevel, Permissions } from "../static/dbManagement.ts";
import { MaybePromise } from "../utils/type.ts";
import { promissify } from "../utils/promises.ts";

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

  private ac = new AbortController();

  private userMap = new Map<WebSocket, string>();

  onSocketClose: undefined | ((socket: WebSocket) => void);

  closed;
  private completeClose: undefined | ((value?: unknown) => void);
  private connections = new Set<WebSocket>();

  constructor(
    handlerManager: HandlerManager,
    dbManager: DatabaseManagement,
    serverOptions: Partial<ServerOptions>,
  ) {
    this.dbManager = dbManager;
    this.handlerManager = handlerManager;
    this.options = Object.assign(defaultServerOptions, serverOptions);

    this.closed = new Promise((resolve) => {
      this.completeClose = resolve;
    });
  }

  serve() {
    const server = Deno.serve(
      {
        ...this.options,
        onListen({ hostname, port }) {
          log("HTTP/WS", `Andromeda Shelf listens on ws://${hostname}:${port}`);
        },
        signal: this.ac.signal,
      },
      (req, conInfo) => {
        let hostname = "dummy";
        if (Object.keys(conInfo).length !== 0) {
          hostname = conInfo.remoteAddr.hostname;
        }

        if (req.method === "POST") {
          log("HTTP", hostname, "Request:", new URL(req.url).pathname);
          return this.handleHttpPostRequest(req);
        }

        if (req.headers.get("upgrade") !== "websocket") {
          return new Response(null, { status: 426 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);

        socket.addEventListener("open", () => {
          log("WS", hostname, "Open");
          this.connections.add(socket);
        });

        socket.addEventListener("close", () => {
          log("WS", hostname, "Close");
          this.onSocketClose?.(socket);
          this.userMap.delete(socket);
          this.connections.delete(socket);
        });

        socket.addEventListener("message", (event) => {
          log("WS", hostname, "Message:", event.data);
          this.handleWebSocketCommand(socket, event);
        });

        return response;
      },
    );

    server.finished.then(() => {
      log("HTTP/WS", "Server has terminated");
      this.completeClose?.();
    });
  }

  close() {
    log("HTTP/WS", "Terminating sessions...");

    for (const socket of this.connections) {
      this.closeSocket(socket, 1001, "Andromeda Shelf is closing. Goodbye!");
    }

    this.ac.abort();
  }

  closeSocket(
    socket: WebSocket,
    code: number = 1000,
    reason: string = "<no reason>",
  ) {
    // Send message just in case the client (like websocat) doesn't handle close properly
    socket.send(`CLOSE [${code}] - ${reason} -`);
    socket.close(code, reason);
  }

  protected async handleHttpPostRequest(req: Request): Promise<Response> {
    try {
      if (!req.headers.has("Authorization")) {
        log("HTTP", "Unauthorized user. No token specified");
        return this.errorHTML(401, "No token specified");
      }

      const auth = req.headers.get("Authorization")!;
      if (!auth.startsWith("JWT ")) {
        log("HTTP", "Unauthorized user. Wrong token type specified");
        return this.errorHTML(401, "Wrong token type specified");
      }

      const userUUID = await this.dbManager.validateJWT(auth.slice(4));
      if (!userUUID) {
        log("HTTP", "Unauthorized user. Invalid token specified");
        return this.errorHTML(403, "Invalid token");
      }
      if (!this.dbManager.userExists(userUUID)) {
        log("HTTP", "Unknown user");
        return this.errorHTML(401, "Unknown user");
      }

      const url = new URL(req.url);
      const command = url.pathname.slice(1).split("/")[0];

      if (!command) {
        log("HTTP", "Invalid request received: No command");
        return this.errorHTML(400, "No command specified");
      }

      if (!(command in this.handlerManager.hpHandlers)) {
        log("HTTP", "Unknown command:", command);
        return this.errorHTML(404, "Unknown command specified");
      }

      const entry = this.handlerManager.hpHandlers[command];
      const options: Record<any, any> = {};

      options.userUUID = userUUID;
      options.request = req;
      options.url = url;

      for (const flag of entry.flags) {
        // @ts-ignore we're checking if it is a Permission
        if (Object.values(Permissions).includes(flag) && userUUID) {
          if (
            !this.dbManager.hasUserPermission(userUUID, flag as Permissions)
          ) {
            log("HTTP", "Unauthorized user. No permission");
            return this.errorHTML(403, "No permission");
          }
        } else if (flag in PermissionLevel && userUUID) {
          if (
            this.dbManager.hasUserPermissionLevel(
              userUUID,
              flag as PermissionLevel,
            )
          ) {
            log("HTTP", "Unauthorized user. Below permission level");
            return this.errorHTML(403, "Below required permission level");
          }
        }
      }

      try {
        return entry.handler(options);
      } catch (err) {
        log("HTTP", `Error in handler '${command}': ${err}`);
        return this.errorHTML(
          500,
          "An error occured within the handler for your proccess",
        );
      }
    } catch (err) {
      log("HTTP", "Invalid request received: " + err);
      return this.errorHTML(400, "Server failed to process request");
    }
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

      if (userUUID && !this.dbManager.userExists(userUUID)) {
        error("auth: unknown user");
        log("WS", "Unknown user");
        return;
      }

      options.userUUID = userUUID;
      options.socket = socket;

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
            log("WS", "Unauthorized user. Below permission level");
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

      const handleError = (err: unknown) => {
        if (typeof err === "string") {
          error(err);
        } else {
          error("failed: execution");
          log("WS", `Error in handler '${command}': ${err}`);
          if ((err as any).stack) console.error((err as Error).stack);
        }
      };

      options.wrapPromise = (fn: MaybePromise<any>) => {
        if (!(fn instanceof Promise)) {
          fn = promissify(fn);
        }

        (fn as Promise<any>).catch((err) => handleError(err));
        return fn;
      };

      try {
        entry.handler(options);
      } catch (err) {
        handleError(err);
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

  errorHTML(status: number, msg?: string) {
    return new Response(msg, { status, statusText: msg });
  }
}
