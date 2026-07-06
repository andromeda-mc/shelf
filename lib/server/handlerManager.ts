// deno-lint-ignore-file ban-types no-explicit-any
import { PermissionLevel, Permissions } from "../dbManagement.ts";
import { MaybePromise } from "../utils/type.ts";
import type { MessageData } from "./httpWsServer.ts";
import * as v from "@valibot/valibot";

type GenericSchema = v.ObjectSchema<any, undefined>;
type BaseSchema = GenericSchema | undefined;

// public allows unauthorized users
// force-public allows *only* unauthorized users

export type CommandFlags = Permissions | PermissionLevel;
export type AdvancedCommandFlags = CommandFlags | "public" | "force-public";

interface Command<Resp, Flags> {
  handler: (options: any) => Resp;
  flags: readonly Flags[];
}

interface WsCommand extends Command<void, AdvancedCommandFlags> {
  schema: BaseSchema;
}
type HpCommand = Command<MaybePromise<Response>, CommandFlags>;

type BaseOptions<
  Flags extends readonly AdvancedCommandFlags[],
  Schema extends BaseSchema,
> = (Schema extends GenericSchema ? { data: v.InferOutput<Schema> } : {}) &
  ("force-public" extends Flags[number]
    ? {}
    : "public" extends Flags[number]
      ? { userUUID?: string }
      : { userUUID: string });

type WSCOptions<Flags extends readonly AdvancedCommandFlags[]> = {
  respond: (message: MessageData) => void;
  authConnection: (userUUID: string) => void;
};

type HPEOptions<Flags extends readonly CommandFlags[]> = { request: Request };

export class HandlerManager {
  wsHandlers: Record<string, WsCommand> = {};
  hpHandlers: Record<string, HpCommand> = {};

  addWebSocketHandler<
    Flags extends readonly AdvancedCommandFlags[],
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
    handler: (
      options: HPEOptions<Flags> & BaseOptions<Flags, Schema>,
    ) => Response,
    ...flags: Flags
  ) {
    this.hpHandlers[command] = { handler, flags };
  }
}
