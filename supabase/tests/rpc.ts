import type pg from "pg";

import { type Rpc, RpcError } from "../../src/lib/tickets/transitions.ts";

/**
 * The rpc port of src/lib/tickets and src/lib/cron over a pg connection: the same
 * public.rpc_* wrappers the server calls through supabase-js, with named
 * arguments, inside the test transaction. Each call runs in a savepoint so a
 * refused call (RDxxx) leaves the transaction usable, like a separate request.
 */
export function pgRpc(db: pg.Client): Rpc {
  return async (fn, args) => {
    if (!/^rpc_[a-z_]+$/.test(fn)) throw new Error(`Not an rpc wrapper: ${fn}`);
    const names = Object.keys(args).filter((k) => args[k] !== undefined);
    const values = names.map((k) => {
      const v = args[k];
      // Objects and arrays go to jsonb parameters as JSON text.
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const call = `select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
    await db.query("savepoint rpc_call");
    try {
      const { rows } = await db.query(call, values);
      await db.query("release savepoint rpc_call");
      return rows[0].r;
    } catch (error) {
      await db.query("rollback to savepoint rpc_call");
      const { code, message } = error as { code?: string; message: string };
      throw new RpcError(code, message);
    }
  };
}
