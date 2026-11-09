import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Koffi/GVariant errors are not always primitive-convertible. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

interface ShortcutBackend {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface PortalShortcut {
  id: string;
  trigger: string;
}

/** The small, injectable surface used by the portal lifecycle and its tests. */
export interface XdgGlobalShortcutsBindings {
  connect(): unknown;
  getVersion(connection: unknown): number;
  registerApp(connection: unknown): void;
  subscribeActivated(connection: unknown, callback: (id: string) => void): unknown;
  createSession(connection: unknown, callback: (handle: string | null) => void): void;
  bindShortcuts(connection: unknown, session: string, shortcuts: PortalShortcut[]): void;
  /** GNOME-only: change an existing session's grabs without a new approval UI. */
  rebindShortcuts?(appId: string, shortcuts: PortalShortcut[]): void;
  closeSession(connection: unknown, session: string): void;
  unsubscribe(connection: unknown, subscription: unknown): void;
  iterateMainContext(): void;
}

const MODIFIERS: Record<string, string> = {
  ctrl: "CTRL",
  control: "CTRL",
  commandorcontrol: "CTRL",
  alt: "ALT",
  option: "ALT",
  shift: "SHIFT",
  logo: "LOGO",
  meta: "LOGO",
  super: "LOGO",
  command: "LOGO",
};

const SPECIAL_KEYS: Record<string, string> = {
  enter: "Return",
  return: "Return",
  backspace: "BackSpace",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "space",
  insert: "Insert",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  comma: "comma",
  period: "period",
  minus: "minus",
  equal: "equal",
};

/** Convert an Electron accelerator to the XDG GlobalShortcuts trigger syntax. */
export function electronToXdgTrigger(accelerator: string): string | null {
  const parts = accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const keyPart = parts.pop();
  if (!keyPart || parts.length !== accelerator.split("+").length - 1) return null;

  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return null;
    modifiers.add(modifier);
  }

  const keyLower = keyPart.toLowerCase();
  const functionKey = /^f([1-9]|1\d|2[0-4])$/i.test(keyPart) ? keyPart.toUpperCase() : null;
  const key =
    functionKey ?? SPECIAL_KEYS[keyLower] ?? (/^[a-z0-9]$/i.test(keyPart) ? keyPart : null);
  if (!key) return null;

  const order = ["CTRL", "ALT", "SHIFT", "LOGO"];
  return [...order.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

interface EnsurePortalDesktopFileOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  execPath?: string;
  existsSync?: (file: string) => boolean;
  readFileSync?: (file: string, encoding: BufferEncoding) => string;
  mkdirSync?: (directory: string, options: { recursive: true }) => unknown;
  writeFileSync?: (file: string, content: string, encoding: BufferEncoding) => void;
}

/** Must match `build.appId` in package.json and the desktop file basename. */
export const PORTAL_APP_ID = "com.wfhelper.app";

/** Spaces and shell metacharacters need the desktop-entry quoting rules. */
function quoteDesktopExec(execPath: string): string {
  if (/^[A-Za-z0-9_./+-]+$/.test(execPath)) return execPath;
  return `"${execPath.replace(/(["\\`$])/g, "\\$1")}"`;
}

/** Ensure the portal's host registry can resolve the wfhelper application ID.
 *
 *  The registry validates the app id against a .desktop file and rejects the
 *  entry when its Exec does not resolve. An AppImage's binary lives under a
 *  fresh /tmp/.mount_* path on every launch, so the file is rewritten with the
 *  current executable instead of a bare `wfhelper` that is not on PATH. */
export function ensurePortalDesktopFile(options: EnsurePortalDesktopFileOptions = {}): string {
  const env = options.env ?? process.env;
  const userData =
    env.XDG_DATA_HOME || path.join(options.homeDir ?? os.homedir(), ".local", "share");
  const desktopName = `${PORTAL_APP_ID}.desktop`;
  const userDesktop = path.join(userData, "applications", desktopName);
  const systemDesktop = `/usr/share/applications/${desktopName}`;
  const existsSync = options.existsSync ?? fs.existsSync;
  if (!existsSync(userDesktop) && existsSync(systemDesktop)) return systemDesktop;

  const readFileSync = options.readFileSync ?? fs.readFileSync;
  let current: string | null = null;
  if (existsSync(userDesktop)) {
    try {
      current = readFileSync(userDesktop, "utf8");
    } catch {
      current = null;
    }
  }
  // Leave a hand-written user entry alone when a packaged system entry exists.
  if (current !== null && !current.includes("X-WFHelper-Portal=1") && existsSync(systemDesktop)) {
    return systemDesktop;
  }

  const execPath = options.execPath ?? process.execPath;
  const contents = `[Desktop Entry]\nType=Application\nName=WFHelper\nNoDisplay=true\nExec=${quoteDesktopExec(
    execPath,
  )}\nX-WFHelper-Portal=1\n`;
  if (current !== contents) {
    const directory = path.dirname(userDesktop);
    (options.mkdirSync ?? fs.mkdirSync)(directory, { recursive: true });
    (options.writeFileSync ?? fs.writeFileSync)(userDesktop, contents, "utf8");
  }
  return userDesktop;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- koffi/GVariant are dynamic C FFI surfaces */
interface NativeKoffi {
  load(name: string): { func(signature: string): (...args: any[]) => any };
  proto(signature: string): unknown;
  pointer(type: unknown): unknown;
  struct(name: string, fields: Record<string, string>): unknown;
  decode(pointer: any, type: unknown): any;
  register(callback: (...args: any[]) => void, type: unknown): unknown;
  unregister(callback: unknown): void;
}

function loadNativeBindings(log: Logger): XdgGlobalShortcutsBindings {
  const koffi = require("koffi") as NativeKoffi;
  const glib = koffi.load("libglib-2.0.so.0");
  const gio = koffi.load("libgio-2.0.so.0");

  const gBusGetSync = gio.func(
    "void *g_bus_get_sync(int bus_type, void *cancellable, _Out_ void **error)",
  );
  const gDbusCall = gio.func(
    "void *g_dbus_connection_call_sync(void *connection, const char *bus_name, const char *object_path, const char *interface_name, const char *method_name, void *parameters, void *reply_type, int flags, int timeout_msec, void *cancellable, _Out_ void **error)",
  );
  const gSignalSubscribe = gio.func(
    "unsigned int g_dbus_connection_signal_subscribe(void *connection, const char *sender, const char *interface_name, const char *member, const char *object_path, const char *arg0, int flags, void *callback, void *user_data, void *user_data_free_func)",
  );
  const gSignalUnsubscribe = gio.func(
    "void g_dbus_connection_signal_unsubscribe(void *connection, unsigned int subscription_id)",
  );
  // Never iterate GLib's default context: Electron/GTK owns it, and pumping GTK
  // events from a Node timer reenters Chromium. Signals attach to this private
  // context instead.
  const portalContext = glib.func("void *g_main_context_new(void)")();
  const gMainContextPush = glib.func("void g_main_context_push_thread_default(void *context)");
  const gMainContextPop = glib.func("void g_main_context_pop_thread_default(void *context)");
  const gMainContextIteration = glib.func(
    "int g_main_context_iteration(void *context, int may_block)",
  );
  function withPortalContext<T>(fn: () => T): T {
    gMainContextPush(portalContext);
    try {
      return fn();
    } finally {
      gMainContextPop(portalContext);
    }
  }

  const gVariantNew = glib.func("void *g_variant_new(const char *format_string, ...)");
  const gVariantNewString = glib.func("void *g_variant_new_string(const char *string)");
  const gVariantBuilderNew = glib.func("void *g_variant_builder_new(void *type)");
  const gVariantTypeNew = glib.func("void *g_variant_type_new(const char *type_string)");
  const gVariantBuilderAdd = glib.func(
    "void g_variant_builder_add(void *builder, const char *format_string, ...)",
  );
  const gVariantBuilderEnd = glib.func("void *g_variant_builder_end(void *builder)");
  const gVariantBuilderUnref = glib.func("void g_variant_builder_unref(void *builder)");
  const gVariantGetChildValue = glib.func(
    "void *g_variant_get_child_value(void *value, unsigned long index)",
  );
  const gVariantGetString = glib.func(
    "const char *g_variant_get_string(void *value, _Out_ unsigned long *length)",
  );
  const gVariantGetUint32 = glib.func("unsigned int g_variant_get_uint32(void *value)");
  const gVariantLookupValue = glib.func(
    "void *g_variant_lookup_value(void *dictionary, const char *key, void *expected_type)",
  );
  const gVariantUnref = glib.func("void g_variant_unref(void *value)");
  const gErrorFree = glib.func("void g_error_free(void *error)");
  const GErrorType = koffi.struct("GError", {
    domain: "uint32",
    code: "int",
    message: "char *",
  });
  function gErrorMessage(error: any): string {
    if (!error) return "Unknown D-Bus error";
    try {
      const decoded = koffi.decode(error, GErrorType) as { message?: string };
      return decoded?.message || "Unknown D-Bus error";
    } catch {
      return "Unknown D-Bus error";
    }
  }
  const signalCallbackType = koffi.proto(
    "void PortalSignalCallback(void *connection, const char *sender, const char *object_path, const char *interface_name, const char *signal_name, void *parameters, void *user_data)",
  );

  function variantDict(entries: Record<string, string>): any {
    const type = gVariantTypeNew("a{sv}");
    const builder = gVariantBuilderNew(type);
    for (const [key, value] of Object.entries(entries)) {
      gVariantBuilderAdd(builder, "{sv}", "str", key, "void *", gVariantNewString(value));
    }
    const result = gVariantBuilderEnd(builder);
    gVariantBuilderUnref(builder);
    return result;
  }

  function variantDictOfVariants(entries: Record<string, any>): any {
    const type = gVariantTypeNew("a{sv}");
    const builder = gVariantBuilderNew(type);
    for (const [key, value] of Object.entries(entries)) {
      gVariantBuilderAdd(builder, "{sv}", "str", key, "void *", value);
    }
    const result = gVariantBuilderEnd(builder);
    gVariantBuilderUnref(builder);
    return result;
  }

  /** Portal triggers use `CTRL+F8`; the GNOME settings provider uses `<ctrl>F8`. */
  function gnomeTrigger(trigger: string): string {
    const modifiers: Record<string, string> = {
      CTRL: "<ctrl>",
      SHIFT: "<shift>",
      ALT: "<alt>",
      LOGO: "<super>",
      NUM: "<mod2>",
    };
    return trigger
      .split("+")
      .map((part) => modifiers[part] ?? part)
      .join("");
  }

  function shortcutArray(shortcuts: PortalShortcut[]): any {
    const type = gVariantTypeNew("a(sa{sv})");
    const builder = gVariantBuilderNew(type);
    for (const shortcut of shortcuts) {
      const triggerType = gVariantTypeNew("as");
      const triggerBuilder = gVariantBuilderNew(triggerType);
      gVariantBuilderAdd(triggerBuilder, "s", "str", gnomeTrigger(shortcut.trigger));
      const triggers = gVariantBuilderEnd(triggerBuilder);
      gVariantBuilderUnref(triggerBuilder);
      const options = variantDictOfVariants({
        description: gVariantNewString(shortcut.id),
        shortcuts: triggers,
      });
      gVariantBuilderAdd(builder, "(s@a{sv})", "str", shortcut.id, "void *", options);
    }
    const result = gVariantBuilderEnd(builder);
    gVariantBuilderUnref(builder);
    return result;
  }

  function call(
    connection: any,
    interfaceName: string,
    method: string,
    parameters: any,
    objectPath = "/org/freedesktop/portal/desktop",
    busName = "org.freedesktop.portal.Desktop",
  ): any {
    const error: any[] = [null];
    let reply: any;
    // The call consumes the floating parameters reference; unreffing it here
    // would drop it twice and emit GLib criticals.
    reply = gDbusCall(
      connection,
      busName,
      objectPath,
      interfaceName,
      method,
      parameters,
      null,
      0,
      5000,
      null,
      error,
    );
    if (!reply) {
      const detail = gErrorMessage(error[0]);
      if (error[0]) gErrorFree(error[0]);
      throw new Error(`${interfaceName}.${method} failed: ${detail}`);
    }
    return reply;
  }

  function subscribe(
    connection: any,
    interfaceName: string,
    member: string,
    objectPath: string | null,
    callback: (parameters: any, signalObjectPath: string) => void,
  ): any {
    const cb = koffi.register(
      (
        _conn: unknown,
        _sender: unknown,
        signalPath: unknown,
        _iface: unknown,
        _member: unknown,
        parameters: any,
      ) => {
        try {
          callback(parameters, typeof signalPath === "string" ? signalPath : "");
        } catch (err) {
          // An exception escaping into the Koffi trampoline takes the process
          // down, so portal callbacks fail closed and stay logged.
          log.warn("[XdgGlobalShortcuts] signal callback failed:", errorText(err));
        }
      },
      koffi.pointer(signalCallbackType),
    );
    const id = withPortalContext(() =>
      gSignalSubscribe(
        connection,
        null,
        interfaceName,
        member,
        objectPath,
        null,
        0,
        cb,
        null,
        null,
      ),
    );
    return { id, cb, closed: false };
  }

  function unsubscribe(connection: any, subscription: any): void {
    if (!subscription || subscription.closed) return;
    subscription.closed = true;
    gSignalUnsubscribe(connection, subscription.id);
    koffi.unregister(subscription.cb);
  }

  const requestInterface = "org.freedesktop.portal.Request";
  const sessionInterface = "org.freedesktop.portal.Session";
  const shortcutsInterface = "org.freedesktop.portal.GlobalShortcuts";
  let cachedConnection: any = null;
  let activatedSubscription: any = null;
  const transientSubscriptions = new Set<any>();

  function unsubscribeAfterCallback(connection: any, subscription: any): void {
    transientSubscriptions.delete(subscription);
    // Koffi cannot unregister the callback that is currently on the stack;
    // defer until the trampoline has returned.
    setImmediate(() => {
      try {
        unsubscribe(connection, subscription);
      } catch (err) {
        log.warn("[XdgGlobalShortcuts] deferred unsubscribe failed:", errorText(err));
      }
    });
  }

  function clearTransientSubscriptions(connection: any): void {
    for (const subscription of [...transientSubscriptions]) {
      transientSubscriptions.delete(subscription);
      unsubscribe(connection, subscription);
    }
  }

  return {
    connect() {
      if (cachedConnection) return cachedConnection;
      const error: any[] = [null];
      const connection = withPortalContext(() => gBusGetSync(2, null, error));
      if (!connection) {
        const message = error[0] ? "Could not connect to the session bus" : "No session bus";
        if (error[0]) gErrorFree(error[0]);
        throw new Error(message);
      }
      cachedConnection = connection;
      return connection;
    },
    getVersion(connection) {
      const reply = call(
        connection,
        "org.freedesktop.DBus.Properties",
        "Get",
        gVariantNew("(ss)", "str", shortcutsInterface, "str", "version"),
      );
      try {
        const outer = gVariantGetChildValue(reply, 0);
        try {
          const value = gVariantGetChildValue(outer, 0);
          try {
            return gVariantGetUint32(value);
          } finally {
            gVariantUnref(value);
          }
        } finally {
          gVariantUnref(outer);
        }
      } finally {
        gVariantUnref(reply);
      }
    },
    registerApp(connection) {
      const options = variantDict({});
      const parameters = gVariantNew("(s@a{sv})", "str", PORTAL_APP_ID, "void *", options);
      const reply = call(
        connection,
        "org.freedesktop.host.portal.Registry",
        "Register",
        parameters,
      );
      gVariantUnref(reply);
    },
    subscribeActivated(connection, callback) {
      activatedSubscription = subscribe(
        connection,
        shortcutsInterface,
        "Activated",
        null,
        (parameters) => {
          const idValue = gVariantGetChildValue(parameters, 1);
          try {
            callback(String(gVariantGetString(idValue, null)));
          } finally {
            gVariantUnref(idValue);
          }
        },
      );
      return activatedSubscription;
    },
    createSession(connection, callback) {
      const token = `wfhelper_${process.pid}_${Date.now()}`;
      const requestToken = `${token}_request`;
      let expectedRequestPath = "";
      const subscription = subscribe(
        connection,
        requestInterface,
        "Response",
        null,
        (response, signalPath) => {
          if (
            (expectedRequestPath && signalPath && signalPath !== expectedRequestPath) ||
            (!expectedRequestPath && signalPath && !signalPath.endsWith(`/${requestToken}`))
          ) {
            return;
          }
          const responseCode = gVariantGetChildValue(response, 0);
          const results = gVariantGetChildValue(response, 1);
          try {
            if (gVariantGetUint32(responseCode) !== 0) {
              callback(null);
              return;
            }
            const handle = gVariantLookupValue(results, "session_handle", null);
            if (!handle) {
              callback(null);
              return;
            }
            try {
              callback(String(gVariantGetString(handle, null)));
            } finally {
              gVariantUnref(handle);
            }
          } finally {
            gVariantUnref(responseCode);
            gVariantUnref(results);
            unsubscribeAfterCallback(connection, subscription);
          }
        },
      );
      transientSubscriptions.add(subscription);

      const options = variantDict({
        session_handle_token: token,
        handle_token: requestToken,
      });
      const parameters = gVariantNew("(@a{sv})", "void *", options);
      try {
        const reply = call(connection, shortcutsInterface, "CreateSession", parameters);
        try {
          const pathValue = gVariantGetChildValue(reply, 0);
          try {
            expectedRequestPath = String(gVariantGetString(pathValue, null));
          } finally {
            gVariantUnref(pathValue);
          }
        } finally {
          gVariantUnref(reply);
        }
      } catch (err) {
        transientSubscriptions.delete(subscription);
        unsubscribe(connection, subscription);
        throw err;
      }
    },
    bindShortcuts(connection, session, shortcuts) {
      const arrayType = gVariantTypeNew("a(sa{sv})");
      const builder = gVariantBuilderNew(arrayType);
      for (const shortcut of shortcuts) {
        const options = variantDict({
          preferred_trigger: shortcut.trigger,
          description: shortcut.id,
        });
        gVariantBuilderAdd(builder, "(s@a{sv})", "str", shortcut.id, "void *", options);
      }
      const array = gVariantBuilderEnd(builder);
      gVariantBuilderUnref(builder);
      const bindOptions = variantDict({ handle_token: `wfhelper_bind_${Date.now()}` });
      const parameters = gVariantNew(
        "(o@a(sa{sv})s@a{sv})",
        "str",
        session,
        "void *",
        array,
        "str",
        "",
        "void *",
        bindOptions,
      );
      const reply = call(connection, shortcutsInterface, "BindShortcuts", parameters);
      let requestPath: string;
      try {
        const pathValue = gVariantGetChildValue(reply, 0);
        try {
          requestPath = String(gVariantGetString(pathValue, null));
        } finally {
          gVariantUnref(pathValue);
        }
      } finally {
        gVariantUnref(reply);
      }
      const subscription = subscribe(connection, requestInterface, "Response", requestPath, () => {
        unsubscribeAfterCallback(connection, subscription);
      });
      transientSubscriptions.add(subscription);
    },
    rebindShortcuts(appId, shortcuts) {
      if (!cachedConnection) throw new Error("Session bus is not connected");
      const array = shortcutArray(shortcuts);
      const parameters = gVariantNew("(s@a(sa{sv}))", "str", appId, "void *", array);
      const reply = call(
        cachedConnection,
        "org.gnome.GlobalShortcutsRebind",
        "RebindShortcuts",
        parameters,
        "/org/gnome/globalshortcuts",
        "org.freedesktop.impl.portal.desktop.gnome",
      );
      gVariantUnref(reply);
    },
    closeSession(connection, session) {
      const reply = call(connection, sessionInterface, "Close", gVariantNew("()"), session);
      gVariantUnref(reply);
      clearTransientSubscriptions(connection);
      if (activatedSubscription) {
        unsubscribe(connection, activatedSubscription);
        activatedSubscription = null;
      }
    },
    unsubscribe(connection, subscription) {
      if (subscription === activatedSubscription) activatedSubscription = null;
      transientSubscriptions.delete(subscription);
      clearTransientSubscriptions(connection);
      unsubscribe(connection, subscription);
    },
    iterateMainContext() {
      gMainContextIteration(portalContext, 0);
    },
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

interface CreateXdgGlobalShortcutsPortalOptions {
  fallback: ShortcutBackend;
  log: Logger;
  bindings?: XdgGlobalShortcutsBindings;
  desktopFile?: EnsurePortalDesktopFileOptions;
  platform?: string;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

interface RegisteredShortcut {
  callback: () => void;
  portalId: string;
  trigger: string;
  lastFiredAt: number;
}

/** Stable across launches: the portal remembers approvals by app id + id, so a
 *  random id would make GNOME ask again on every session. */
function portalShortcutId(trigger: string): string {
  return `wfhelper_${trigger.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

const BATCH_DELAY_MS = 25;
const POLL_INTERVAL_MS = 50;
const DEDUPLICATION_WINDOW_MS = 150;

/** XDG GlobalShortcuts portal with immediate XWayland globalShortcut fallback. */
export function createXdgGlobalShortcutsPortal(
  options: CreateXdgGlobalShortcutsPortalOptions,
): ShortcutBackend & {
  dispose(): void;
} {
  const registered = new Map<string, RegisteredShortcut>();
  const pending = new Map<string, PortalShortcut>();
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const repeat = options.setInterval ?? globalThis.setInterval;
  const stopRepeat = options.clearInterval ?? globalThis.clearInterval;
  const nativePlatform = (options.platform ?? process.platform) === "linux";
  let bindings = options.bindings;
  let connection: unknown = null;
  let session: string | null = null;
  let sessionBound = false;
  let activatedSubscription: unknown = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let portalUnavailable = false;
  let rebindSupported = true;
  let generation = 0;

  function startPolling(): void {
    if (pollTimer || !bindings || !connection) return;
    pollTimer = repeat(() => {
      try {
        bindings?.iterateMainContext();
      } catch (err) {
        options.log.warn("[XdgGlobalShortcuts] main-context iteration failed:", errorText(err));
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (!pollTimer) return;
    stopRepeat(pollTimer);
    pollTimer = null;
  }

  function subscribeActivatedIfNeeded(): void {
    if (!bindings || !connection || activatedSubscription) return;
    activatedSubscription = bindings.subscribeActivated(connection, (id) => {
      const entry = [...registered.values()].find((candidate) => candidate.portalId === id);
      if (entry) fire(entry);
    });
  }

  function startPortalSession(): void {
    if (!bindings || !connection) return;
    subscribeActivatedIfNeeded();
    const initializedConnection = connection;
    const initializedGeneration = generation;
    bindings.createSession(connection, (handle) => {
      if (generation !== initializedGeneration || connection !== initializedConnection) {
        if (handle) {
          try {
            bindings?.closeSession(initializedConnection, handle);
          } catch (err) {
            options.log.warn("[XdgGlobalShortcuts] stale session close failed:", errorText(err));
          }
        }
        return;
      }
      if (!handle) return;
      if (registered.size === 0) {
        try {
          bindings?.closeSession(initializedConnection, handle);
        } catch (err) {
          options.log.warn("[XdgGlobalShortcuts] empty session close failed:", errorText(err));
        }
        return;
      }
      session = handle;
      sessionBound = false;
      flushPending();
    });
  }

  function ensureInitialized(): void {
    if (!nativePlatform || portalUnavailable || connection || registered.size === 0) return;
    try {
      bindings ??= loadNativeBindings(options.log);
      connection = bindings.connect();
      // The app id has to exist before any portal call, and the registry checks
      // it against a .desktop entry whose Exec resolves on this machine.
      ensurePortalDesktopFile(options.desktopFile);
      try {
        bindings.registerApp(connection);
      } catch (err) {
        options.log.warn("[XdgGlobalShortcuts] app id registration failed:", errorText(err));
      }
      const version = bindings.getVersion(connection);
      if (version < 1) throw new Error(`GlobalShortcuts portal version ${version} is unsupported`);
      startPortalSession();
      startPolling();
      options.log.info("[XdgGlobalShortcuts] connected to the GlobalShortcuts portal");
    } catch (err) {
      portalUnavailable = true;
      options.log.warn(
        "[XdgGlobalShortcuts] portal unavailable; using X11 fallback:",
        errorText(err),
      );
      cleanupPortal();
      portalUnavailable = true;
    }
  }

  function fire(entry: RegisteredShortcut): void {
    const timestamp = now();
    if (timestamp - entry.lastFiredAt < DEDUPLICATION_WINDOW_MS) return;
    entry.lastFiredAt = timestamp;
    try {
      entry.callback();
    } catch (err) {
      options.log.warn("[XdgGlobalShortcuts] shortcut callback failed:", errorText(err));
    }
  }

  function flushPending(): void {
    if (batchTimer) {
      cancel(batchTimer);
      batchTimer = null;
    }
    if (!session || !bindings || pending.size === 0) return;
    const shortcuts = [...registered.values()]
      .filter((entry) => entry.trigger)
      .map((entry) => ({ id: entry.portalId, trigger: entry.trigger }));

    if (sessionBound) {
      // GNOME treats BindShortcuts as a configuration request and shows its
      // dialog for every new session. Rebind the existing session instead so a
      // game restart only changes the grabs, not the user's approval.
      if (rebindSupported && bindings.rebindShortcuts) {
        try {
          bindings.rebindShortcuts(PORTAL_APP_ID, shortcuts);
          pending.clear();
          if (shortcuts.length === 0) stopPolling();
          else startPolling();
          return;
        } catch (err) {
          rebindSupported = false;
          options.log.warn(
            "[XdgGlobalShortcuts] RebindShortcuts failed; recreating session:",
            errorText(err),
          );
        }
      }
      const oldSession = session;
      session = null;
      sessionBound = false;
      activatedSubscription = null;
      generation += 1;
      try {
        bindings.closeSession(connection, oldSession);
      } catch (err) {
        options.log.warn("[XdgGlobalShortcuts] session close on rebind failed:", errorText(err));
      }
      if (shortcuts.length === 0) {
        pending.clear();
        stopPolling();
        return;
      }
      try {
        startPortalSession();
      } catch (err) {
        options.log.warn("[XdgGlobalShortcuts] session recreate failed:", errorText(err));
      }
      return;
    }

    if (shortcuts.length === 0) {
      pending.clear();
      return;
    }
    pending.clear();
    try {
      sessionBound = true;
      bindings.bindShortcuts(connection, session, shortcuts);
      startPolling();
    } catch (err) {
      options.log.warn("[XdgGlobalShortcuts] BindShortcuts failed:", errorText(err));
    }
  }

  function cleanupPortal(): void {
    generation += 1;
    if (batchTimer) {
      cancel(batchTimer);
      batchTimer = null;
    }
    if (pollTimer) {
      stopRepeat(pollTimer);
      pollTimer = null;
    }
    pending.clear();
    if (bindings && connection) {
      if (session) {
        try {
          bindings.closeSession(connection, session);
        } catch (err) {
          options.log.warn("[XdgGlobalShortcuts] session close failed:", errorText(err));
        }
      } else if (activatedSubscription) {
        try {
          bindings.unsubscribe(connection, activatedSubscription);
        } catch (err) {
          options.log.warn("[XdgGlobalShortcuts] signal unsubscribe failed:", errorText(err));
        }
      }
    }
    session = null;
    sessionBound = false;
    connection = null;
    activatedSubscription = null;
    portalUnavailable = false;
  }

  return {
    register(accelerator, callback): boolean {
      if (registered.has(accelerator)) return false;
      const trigger = electronToXdgTrigger(accelerator);
      const entry: RegisteredShortcut = {
        callback,
        portalId: portalShortcutId(trigger ?? accelerator),
        trigger: trigger ?? "",
        lastFiredAt: Number.NEGATIVE_INFINITY,
      };
      const ok = options.fallback.register(accelerator, () => fire(entry));
      if (!ok) return false;
      registered.set(accelerator, entry);
      if (!trigger) return true;

      ensureInitialized();
      if (connection && bindings) {
        pending.set(accelerator, { id: entry.portalId, trigger });
        if (!batchTimer) {
          batchTimer = schedule(() => {
            batchTimer = null;
            flushPending();
          }, BATCH_DELAY_MS);
        }
      }
      return true;
    },
    unregister(accelerator): void {
      const entry = registered.get(accelerator);
      if (!entry) {
        options.fallback.unregister(accelerator);
        return;
      }
      registered.delete(accelerator);
      pending.delete(accelerator);
      options.fallback.unregister(accelerator);
      if (session && entry?.trigger) {
        pending.set(accelerator, { id: entry.portalId, trigger: entry.trigger });
        if (!batchTimer) {
          batchTimer = schedule(() => {
            batchTimer = null;
            flushPending();
          }, BATCH_DELAY_MS);
        }
      } else if (registered.size === 0) {
        // Keep the portal session alive so the next game start can rebind
        // without another approval prompt.
        stopPolling();
      }
    },
    dispose(): void {
      for (const accelerator of [...registered.keys()]) {
        options.fallback.unregister(accelerator);
      }
      registered.clear();
      cleanupPortal();
    },
  };
}
