/**
 * Logger for VM modules — works in both MCP server (Winston) and Electron (console) contexts.
 */

interface LogFn {
  (message: string, meta?: Record<string, unknown>): void;
}

interface VMLogger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}

let _logger: VMLogger | null = null;

function getLogger(): VMLogger {
  if (_logger) return _logger;

  // Try to import Winston logger (MCP server context)
  try {
    // Dynamic require won't work in ESM, so use a safe fallback
    // The MCP server will call setVMLogger() to inject the real logger
    _logger = createConsoleLogger();
  } catch {
    _logger = createConsoleLogger();
  }

  return _logger;
}

function createConsoleLogger(): VMLogger {
  const fmt = (level: string, message: string, meta?: Record<string, unknown>) => {
    const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    return `${new Date().toISOString()} [${level}] ${message}${metaStr}`;
  };

  return {
    info: (msg, meta) => console.log(fmt('INFO', msg, meta)),
    warn: (msg, meta) => console.warn(fmt('WARN', msg, meta)),
    error: (msg, meta) => console.error(fmt('ERROR', msg, meta)),
    debug: (msg, meta) => console.debug(fmt('DEBUG', msg, meta)),
  };
}

/**
 * Inject a real logger (e.g., Winston) from the MCP server context.
 * Call this at MCP server startup.
 */
export function setVMLogger(logger: VMLogger): void {
  _logger = logger;
}

export const vmLogger = new Proxy({} as VMLogger, {
  get(_target, prop: string) {
    return getLogger()[prop as keyof VMLogger];
  },
});
