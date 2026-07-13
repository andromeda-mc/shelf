// deno-lint-ignore-file no-explicit-any
import { HandlerManager } from "./handlerManager.ts";
import { safeParse } from "@valibot/valibot";
import { DatabaseManagement } from "../dbManagement.ts";
import { PermissionLevel, Permissions } from "../static/dbManagement.ts";
import { MaybePromise } from "../utils/type.ts";
import { promissify } from "../utils/promises.ts";
import { getLogger } from "@logtape/logtape";

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

  private logger = getLogger(["Shelf", "HttpWsServer"]);

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
    const logger = this.logger;

    const server = Deno.serve(
      {
        ...this.options,
        onListen({ hostname, port }) {
          logger.info(`Andromeda Shelf listens on ws://${hostname}:${port}`);
        },
        signal: this.ac.signal,
      },
      (req, conInfo) => {
        let hostname = "dummy";
        if (Object.keys(conInfo).length !== 0) {
          hostname = conInfo.remoteAddr.hostname;
        }

        if (req.method === "POST") {
          logger.debug("{hostname} sent POST Request to {url}", {
            hostname,
            url: new URL(req.url).pathname,
          });
          return this.handleHttpPostRequest(req);
        }

        if (req.headers.get("upgrade") !== "websocket") {
          return new Response(null, { status: 426 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);

        socket.addEventListener("open", () => {
          logger.debug("{hostname} connected to WebSocket", { hostname });
          this.connections.add(socket);
        });

        socket.addEventListener("close", () => {
          logger.debug("{hostname} disconnected from WebSocket", { hostname });
          this.onSocketClose?.(socket);
          this.userMap.delete(socket);
          this.connections.delete(socket);
        });

        socket.addEventListener("message", (event) => {
          this.handleWebSocketCommand(socket, event, hostname);
        });

        return response;
      },
    );

    server.finished.then(() => {
      this.logger.debug("Server has terminated");
      this.completeClose?.();
    });
  }

  close() {
    this.logger.debug("Terminating sessions...");

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
        this.logger.warn(
          "HTTP Authentification failed: Unauthorized user. No token specified",
        );
        return this.errorHTML(401, "No token specified");
      }

      const auth = req.headers.get("Authorization")!;
      if (!auth.startsWith("JWT ")) {
        this.logger.warn(
          "HTTP Authentification failed: Unauthorized user. Wrong token type specified",
        );
        return this.errorHTML(401, "Wrong token type specified");
      }

      const userUUID = await this.dbManager.validateJWT(auth.slice(4));
      if (!userUUID) {
        this.logger.warn(
          "HTTP Authentification failed: Unauthorized user. Invalid token specified",
        );
        return this.errorHTML(403, "Invalid token");
      }
      if (!this.dbManager.userExists(userUUID)) {
        this.logger.warn("HTTP Authentification failed: Unknown user");
        return this.errorHTML(401, "Unknown user");
      }

      const url = new URL(req.url);
      const command = url.pathname.slice(1).split("/")[0];

      if (!command) {
        this.logger.warn("Invalid HTTP Request received: No command");
        return this.errorHTML(400, "No command specified");
      }

      if (!(command in this.handlerManager.hpHandlers)) {
        this.logger.warn(
          "Invalid HTTP Request received: Unknown command: {command}",
          { command },
        );
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
            this.logger.warn(
              "HTTP Authentification failed: Unauthorized user. No permission",
            );
            return this.errorHTML(403, "No permission");
          }
        } else if (flag in PermissionLevel && userUUID) {
          if (
            this.dbManager.hasUserPermissionLevel(
              userUUID,
              flag as PermissionLevel,
            )
          ) {
            this.logger.warn(
              "HTTP Authentification failed: Unauthorized user. Below permission level",
            );
            return this.errorHTML(403, "Below required permission level");
          }
        }
      }

      try {
        return entry.handler(options);
      } catch (err) {
        if (err instanceof Error) {
          this.logger.error(
            "HTTP Handling: Error in handler for {command}: {err}",
            {
              err,
              command,
            },
          );
        } else {
          this.logger.error("HTTP Handling: Error in handler for {command}", {
            command,
          });
        }

        return this.errorHTML(
          500,
          "An error occured within the handler for your proccess",
        );
      }
    } catch (err) {
      if (err instanceof Error) {
        this.logger.warn("Invalid HTTP Request received: {err}", {
          err,
        });
      } else {
        this.logger.warn("Invalid HTTP Request received");
      }
      return this.errorHTML(400, "Server failed to process request");
    }
  }

  protected handleWebSocketCommand(
    socket: WebSocket,
    event: MessageEvent,
    hostname: string,
  ) {
    try {
      const msg = JSON.parse(event.data);
      const command = msg.data;

      this.logger.debug("{hostname} sent WebSocket Message: {data}", {
        hostname,
        data: msg,
      });

      if (!command) {
        this.errorWS(socket, "invalid: no data");
        this.logger.warn("Invalid WS Message received: No command");
        return;
      }

      const error = (msg: string) => {
        this.errorWS(socket, msg, { responseTo: command });
      };

      if (!(command in this.handlerManager.wsHandlers)) {
        error("invalid: command");
        this.logger.warn(
          "Invalid WS Message received: Unknown command: {command}",
          { command },
        );
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
        this.logger.warn("WS Authentification failed: Unauthorized user");
        return;
      }

      if (userUUID && entry.flags.includes("force-public")) {
        error("auth: authed users disallowed");
        this.logger.warn(
          "WS Authentification failed: Authenticated users are disallowed",
        );
        return;
      }

      if (userUUID && !this.dbManager.userExists(userUUID)) {
        error("auth: unknown user");
        this.logger.warn("WS Authentification failed: Unknown user");
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
            this.logger.warn(
              "WS Authentification failed: Unauthorized user. No permission",
            );
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
            this.logger.warn(
              "WS Authentification failed: Unauthorized user. Below permission level",
            );
            return;
          }
        }
      }

      if (entry.schema) {
        const parseResult = safeParse(entry.schema, msg);

        if (!parseResult.success) {
          const issues = parseResult.issues.map((i) => i.message).join("; ");

          error("validation: " + issues);
          this.logger.warn("WS Handler found, but schema failed: {issues}", {
            issues,
          });
          return;
        }

        options.data = parseResult.output;
      }

      options.respond = (data: MessageData) => {
        this.sendWS(socket, { ...data, responseTo: command });
      };

      options.authConnection = (userUUID: string) => {
        this.logger.debug("{hostname} has authenticated for user {userUUID}", {
          hostname,
          userUUID,
        });

        this.userMap.set(socket, userUUID);
      };

      const handleError = (err: unknown) => {
        if (typeof err === "string") {
          error(err);
        } else {
          error("failed: execution");
          if (err instanceof Error) {
            this.logger.error(
              "WS Handling: Error in handler for {command}: {err}",
              {
                err,
                command,
              },
            );
          } else {
            this.logger.error("WS Handling: Error in handler for {command}");
          }
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
      this.logger.debug("{hostname} sent WebSocket Message: {data}", {
        hostname,
        data: event.data,
      });
      this.errorWS(socket, "invalid: msg");
      if (err instanceof Error) {
        this.logger.warn("Invalid WS Message received: {err}", {
          err,
        });
      } else {
        this.logger.warn("Invalid WS Message received");
      }
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
