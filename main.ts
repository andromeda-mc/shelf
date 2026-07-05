import { log } from "./lib/server/httpWsServer.ts";
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
import { HttpServer } from "./lib/server/httpWsServer.ts";
import { HandlerManager } from "./lib/server/handlerManager.ts";

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

if (import.meta.main) {
  log("StartUp", "Initialising DatabaseManager...");
  const dbManager = new DatabaseManagement();

  log("StartUp", "Initialising QueueManager...");
  const queueManager = new QueueManager();

  log("StartUp", "Initialising JavaFinder...");
  const javas = new JavaFinder(dbManager);

  log("StartUp", "Initialising ServerManager...");
  const serverManager = new ServerManager(dbManager, javas);

  log("StartUp", "Initialising HandleManager...");
  const handleManager = new HandlerManager();

  handleManager.addWebSocketHandler(
    "version",
    (options) => {
      options.respond({ data: "api_version", version: API_VERSION });
    },
    undefined,
    "public",
  );

  handleManager.addWebSocketHandler(
    "auth",
    (options) => {
      const user = dbManager.findUserByUsername(options.data.username);
      if (!user) throw "auth: unknown user";

      const success = dbManager.validateLoginHash(
        options.data.password,
        user.uuid,
      );
      if (!success) throw "auth: failed";

      options.authConnection(user.uuid);
      options.respond({ data: "welcome" });
    },
    AuthSchema,
    "force-public",
  );

  handleManager.addWebSocketHandler(
    "create-server",
    (options) => {
      const info = options.data as ServerCreationInfo;
      const promise = serverManager.createServer(info);

      queueManager.scheduleTask({
        title: "Creating server " + name,
        type: "Server creation",
        description: `${info.software} ${info.software_version} for ${info.mc_version}`,
        promise,
        notifyOnFinish: true,
      });
    },
    CreateServerSchema,
    Permissions.CreateServer,
  );

  handleManager.addWebSocketHandler(
    "start-server",
    (options) => {
      const { uuid } = options.data;
      const info = dbManager.getServer(uuid);
      const promise = serverManager.startServer(uuid);

      queueManager.scheduleTask({
        title: "Starting server " + info.name,
        type: "Server starting",
        promise,
        notifyOnFinish: false,
      });
    },
    SimpleServerActionSchema,
    Permissions.StartServer,
  );

  handleManager.addWebSocketHandler(
    "stop-server",
    (options) => {
      const { uuid } = options.data;
      const info = dbManager.getServer(uuid);
      const promise = promissify(() => {
        serverManager.stopServer(uuid);
      });

      queueManager.scheduleTask({
        title: "Stopping server " + info.name,
        type: "Server stopping",
        promise,
        notifyOnFinish: false,
      });
    },
    SimpleServerActionSchema,
    Permissions.StopServer,
  );

  log("StartUp", "Initialising MainServer...");
  const server = new HttpServer(handleManager, dbManager, {});

  queueManager.onQueueAdded = (task) => {
    server.sendAllWS({ data: "queue-new-task", task });
  };
  queueManager.onQueueRemoved = (taskUUID) => {
    server.sendAllWS({ data: "queue-remove-task", taskUUID });
  };
  queueManager.onNotificationAdded = (notification) => {
    server.sendAllWS({ data: "queue-new-notification", notification });
  };

  log("StartUp", "Starting MainServer...");
  server.serve();
}
