/* eslint-disable @typescript-eslint/no-explicit-any -- koffi/GLib are dynamic FFI surfaces */

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

interface Logger {
  warn: (...args: unknown[]) => void;
}

interface NativeKoffi {
  load(name: string): { func(signature: string): (...args: any[]) => any };
  proto(signature: string): unknown;
  pointer(type: unknown): unknown;
  struct(name: string, fields: Record<string, string>): unknown;
  decode(pointer: any, type: unknown): any;
  register(callback: (...args: any[]) => void, type: unknown): unknown;
  unregister(callback: unknown): void;
}

export interface GlibSessionBus {
  subscribe(
    interfaceName: string,
    member: string,
    objectPath: string,
    callback: (argument: string) => void,
  ): void;
  dispose(): void;
}

const SESSION_BUS = 2;
const POLL_INTERVAL_MS = 50;

interface Subscription {
  id: number;
  callback: unknown;
}

/** A private session-bus signal source.
 *
 *  Electron owns GLib's default main context; iterating it re-enters Chromium
 *  and crashed the app before. Every subscription therefore lives on its own
 *  context, pumped by a small timer. */
export function createGlibSessionBus(log: Logger): GlibSessionBus {
  const koffi = require("koffi") as NativeKoffi;
  const glib = koffi.load("libglib-2.0.so.0");
  const gio = koffi.load("libgio-2.0.so.0");

  const gBusGetSync = gio.func(
    "void *g_bus_get_sync(int bus_type, void *cancellable, _Out_ void **error)",
  );
  const gSignalSubscribe = gio.func(
    "unsigned int g_dbus_connection_signal_subscribe(void *connection, const char *sender, const char *interface_name, const char *member, const char *object_path, const char *arg0, int flags, void *callback, void *user_data, void *user_data_free_func)",
  );
  const gSignalUnsubscribe = gio.func(
    "void g_dbus_connection_signal_unsubscribe(void *connection, unsigned int subscription_id)",
  );
  const gMainContextNew = glib.func("void *g_main_context_new(void)");
  const gMainContextPush = glib.func("void g_main_context_push_thread_default(void *context)");
  const gMainContextPop = glib.func("void g_main_context_pop_thread_default(void *context)");
  const gMainContextIteration = glib.func(
    "int g_main_context_iteration(void *context, int may_block)",
  );
  const gVariantGetChildValue = glib.func(
    "void *g_variant_get_child_value(void *value, unsigned long index)",
  );
  const gVariantGetString = glib.func(
    "const char *g_variant_get_string(void *value, _Out_ unsigned long *length)",
  );
  const gVariantUnref = glib.func("void g_variant_unref(void *value)");
  const gErrorFree = glib.func("void g_error_free(void *error)");
  const GErrorType = koffi.struct("GlibSessionBusError", {
    domain: "uint32",
    code: "int",
    message: "char *",
  });
  const signalCallbackType = koffi.proto(
    "void GlibSessionBusSignalCallback(void *connection, const char *sender, const char *object_path, const char *interface_name, const char *signal_name, void *parameters, void *user_data)",
  );

  const context = gMainContextNew();
  function withContext<T>(fn: () => T): T {
    gMainContextPush(context);
    try {
      return fn();
    } finally {
      gMainContextPop(context);
    }
  }

  const error: any[] = [null];
  const connection = withContext(() => gBusGetSync(SESSION_BUS, null, error));
  if (!connection) {
    let detail = "unknown error";
    try {
      const decoded = error[0]
        ? (koffi.decode(error[0], GErrorType) as { message?: string })
        : null;
      detail = decoded?.message || detail;
    } finally {
      if (error[0]) gErrorFree(error[0]);
    }
    throw new Error(`session bus connect failed: ${detail}`);
  }

  let closed = false;
  const subscriptions = new Set<Subscription>();
  const timer = setInterval(() => {
    try {
      gMainContextIteration(context, 0);
    } catch (err) {
      log.warn("[GlibSessionBus] main-context iteration failed:", errorText(err));
    }
  }, POLL_INTERVAL_MS);
  timer.unref?.();

  function readFirstString(parameters: any): string {
    const child = gVariantGetChildValue(parameters, 0);
    try {
      return String(gVariantGetString(child, null));
    } finally {
      gVariantUnref(child);
    }
  }

  return {
    subscribe(interfaceName, member, objectPath, callback) {
      if (closed) throw new Error("session bus is closed");
      const trampoline = koffi.register(
        (
          _conn: unknown,
          _sender: unknown,
          _path: unknown,
          _iface: unknown,
          _member: unknown,
          parameters: any,
        ) => {
          try {
            callback(readFirstString(parameters));
          } catch (err) {
            // An exception escaping into the Koffi trampoline takes the whole
            // process down, so keep failures inside the callback.
            log.warn("[GlibSessionBus] signal callback failed:", errorText(err));
          }
        },
        koffi.pointer(signalCallbackType),
      );
      try {
        const id = withContext(() =>
          gSignalSubscribe(
            connection,
            null,
            interfaceName,
            member,
            objectPath,
            null,
            0,
            trampoline,
            null,
            null,
          ),
        ) as number;
        subscriptions.add({ id, callback: trampoline });
      } catch (err) {
        koffi.unregister(trampoline);
        throw err;
      }
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const subscription of subscriptions) {
        try {
          gSignalUnsubscribe(connection, subscription.id);
        } catch (err) {
          log.warn("[GlibSessionBus] unsubscribe failed:", errorText(err));
        }
        koffi.unregister(subscription.callback);
      }
      subscriptions.clear();
    },
  };
}
