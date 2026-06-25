// deno-lint-ignore-file no-explicit-any
import { getCommandMap } from "./decorators.ts";
import { format } from "@std/datetime";
import { generate as generateUUID } from "@std/uuid/v7";

export interface Message {
  instance: WebSocket;
  command: string;
  content: MessageData;
  connUUID: string;

  response: (msg: MessageData) => true;
  responseWithException: (exception: string) => false;
}

export interface MessageData {
  data: string;
  [key: string]: any;
}

export function log(module: string, message: string) {
  message = message.replaceAll(/[\n\r]/gm, "");
  const timeStamp = format(new Date(), "yyyy.MM.dd HH:mm:ss");

  console.log(`${module} - [${timeStamp}] : ${message} -`);
}

export abstract class Server {
  port: number = 29836;
  hostname: string = "0.0.0.0";

  constructor(port?: number, hostname?: string) {
    if (port) this.port = port;
    if (hostname) this.hostname = hostname;
  }

  abstract messagePreprocess(message: Message): boolean | undefined;
  abstract onClose(instance: WebSocket, connUUID: string): void;

  serve() {
    for (const entry of getCommandMap(this).keys()) {
      log("WS", "Found handler for: " + entry);
    }

    Deno.serve(
      {
        port: this.port,
        hostname: this.hostname,
        onListen({ hostname, port }) {
          log("WS", `Andromeda Stall listens on ws://${hostname}:${port}`);
        },
      },
      (req, conInfo) => {
        if (req.headers.get("upgrade") != "websocket") {
          return new Response(null, { status: 501 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);
        const { hostname } = conInfo.remoteAddr;
        const connUUID = generateUUID();

        socket.addEventListener("open", () => {
          log("WS", hostname + " Open");
        });

        socket.addEventListener("close", () => {
          log("WS", hostname + " Close");
          this.onClose(socket, connUUID);
        });

        socket.addEventListener("message", (event: MessageEvent) => {
          log("WS", hostname + " Message: " + event.data);
          this.onMessage(socket, connUUID, event.data);
        });

        return response;
      },
    );
  }

  protected send(socket: WebSocket, data: MessageData): void {
    socket.send(JSON.stringify(data));
  }

  protected async onMessage(
    instance: WebSocket,
    connUUID: string,
    raw: string,
  ) {
    try {
      const msg = JSON.parse(raw);
      const command = msg.data;
      if (!command) {
        this.send(instance, { data: "exception", msg: "invalid: no data" });
        return log("WS", "Invalid message received: No data");
      }

      const send = this.send;
      const error = (exception: string) => {
        send(instance, {
          data: "exception",
          responseTo: command,
          msg: exception,
        });
        return false as false;
      };

      const messageData: Message = {
        instance,
        command,
        content: msg,
        connUUID,
        response(msg) {
          send(instance, msg);
          return true;
        },
        responseWithException: error,
      };

      const preprocessResult = this.messagePreprocess(messageData);
      if (preprocessResult !== false) {
        return log("WS", `Preprocess failed for command '${command}'`);
      }

      const commandMap = getCommandMap(this);
      const methodName = commandMap.get(command);

      if (methodName && typeof (this as any)[methodName] === "function") {
        try {
          await (this as any)[methodName](messageData);
        } catch (err) {
          error("failed: execution");
          log("WS", `Error in handler '${command}': ${err}`);
        }
      } else {
        error("invalid: command");
        log("WS", `Unknown command: ${command}`);
      }
    } catch (err) {
      this.send(instance, { data: "exception", msg: "invalid: msg" });
      log("WS", "Invalid message received: " + err);
    }
  }
}
