// deno-lint-ignore-file ban-types no-explicit-any
import { PermissionLevel, Permissions } from "../dbManagement.ts";
import type { MessageData } from "./httpWsServer.ts";
import * as v from "@valibot/valibot";

type GenericSchema = v.ObjectSchema<any, undefined>;
type BaseSchema = GenericSchema | undefined;

// public allows unauthorized users
// force-public allows *only* unauthorized users

export type CommandFlags =
  | Permissions
  | PermissionLevel
  | "public"
  | "force-public";

type Command = {
  handler: (options: any) => void;
  schema: BaseSchema;
  flags: readonly CommandFlags[];
};

type BaseOptions<
  Flags extends readonly CommandFlags[],
  Schema extends BaseSchema,
> = (Schema extends GenericSchema ? { data: v.InferOutput<Schema> } : {}) &
  ("force-public" extends Flags[number]
    ? {}
    : "public" extends Flags[number]
      ? { userUUID?: string }
      : { userUUID: string });

type WSCOptions<Flags extends readonly CommandFlags[]> = {
  respond: (message: MessageData) => void;
  authConnection: (userUUID: string) => void;
};

type HPEOptions<Flags extends readonly CommandFlags[]> = { response: Response };

export class HandlerManager {
  wsHandlers: Record<string, Command> = {};
  hpHandlers: Record<string, Command> = {};

  addWebSocketHandler<
    Flags extends readonly CommandFlags[],
    Schema extends BaseSchema,
  >(
    command: string,
    handler: (options: WSCOptions<Flags> & BaseOptions<Flags, Schema>) => void,
    schema: Schema,
    ...flags: Flags
  ) {
    this.wsHandlers[command] = { handler, schema, flags };
  }

  addHttpPostHandler<
    Flags extends readonly CommandFlags[],
    Schema extends BaseSchema,
  >(
    command: string,
    handler: (options: HPEOptions<Flags> & BaseOptions<Flags, Schema>) => void,
    schema: Schema,
    ...flags: Flags
  ) {
    this.hpHandlers[command] = { handler, schema, flags };
  }
}
