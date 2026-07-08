import { log } from "./lib/server/httpWsServer.ts";
import {
  DatabaseManagement,
  PermissionLevel,
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
import * as vars from "./lib/vars.ts";
import { existsSync } from "@std/fs";

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
      options.respond({
        data: "server-version",
        api_version: vars.API_VERSION,
        software_version: vars.SOFTWARE_VERSION,
      });
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
      options.respond({
        data: "welcome",
        servers: serverManager.listAllVisibleServers(user.uuid),
      });
    },
    AuthSchema,
    "force-public",
  );

  handleManager.addWebSocketHandler(
    "create-server",
    (options) => {
      const info = options.data as ServerCreationInfo;
      const promise = serverManager.createServer(info);
      promise.then((mcServer) =>
        server.sendAllWS({ data: "add-new-server", server: mcServer }),
      );

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
      if (!serverManager.isUserAllowedToAccessServer(options.userUUID, uuid)) {
        throw "unknown: server";
      }
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
      if (!serverManager.isUserAllowedToAccessServer(options.userUUID, uuid)) {
        throw "unknown: server";
      }
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

  handleManager.addWebSocketHandler(
    "delete-server",
    (options) => {
      const { uuid } = options.data;
      if (!serverManager.isUserAllowedToAccessServer(options.userUUID, uuid)) {
        throw "unknown: server";
      }
      const info = dbManager.getServer(uuid);
      const promise = promissify(() => {
        serverManager.deleteServer(uuid);
      });
      promise.then(() => server.sendAllWS({ data: "remove-server", uuid }));

      queueManager.scheduleTask({
        title: "Deleting server " + info.name,
        type: "Server deletion",
        promise,
        notifyOnFinish: true,
      });
    },
    SimpleServerActionSchema,
    Permissions.DeleteServer,
  );

  handleManager.addWebSocketHandler(
    "list-servers",
    (options) => {
      options.respond({
        data: "server-list",
        servers: serverManager.listAllVisibleServers(options.userUUID),
      });
    },
    v.object({}),
  );

  handleManager.addWebSocketHandler(
    "request-jwt-token",
    async (options) => {
      const token = await dbManager.generateJWT(options.userUUID);

      if (!token) {
        throw "auth: rejected";
      }

      return options.respond({ data: "new-jwt-token", token });
    },
    v.object({}),
    PermissionLevel.User,
  );

  handleManager.addWebSocketHandler(
    "remove-notification",
    (options) => {
      queueManager.removeNotification(options.data.uuid);
    },
    SimpleServerActionSchema,
    Permissions.ManageNotifications,
  );

  handleManager.addHttpPostHandler("icon", (options) => {
    const splitPath = options.url.pathname.split("/").slice(2);
    if (splitPath.length === 0) {
      return server.errorHTML(400, "No icon specified");
    }
    const iconPath = dbManager.getIconPath(splitPath[0]);
    if (!existsSync(iconPath)) {
      return server.errorHTML(404, "Unknown icon");
    }
    return new Response(Deno.readFileSync(iconPath), {
      headers: { "Content-Type": "image/png" },
    });
  });

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
  queueManager.onNotificationRemoved = (notificationUUID) => {
    server.sendAllWS({ data: "queue-remove-notification", notificationUUID });
  };

  log("StartUp", "Starting MainServer...");
  server.serve();
}
