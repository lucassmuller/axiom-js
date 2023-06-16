import { config as configurator, Version } from './config';
import { NetlifyInfo } from './platform/netlify';
import { isNoPrettyPrint } from './shared';
import { Client, ClientOptions } from '@axiomhq/js';

const LOG_LEVEL = process.env.AXIOM_LOG_LEVEL || 'debug';

export interface LogEvent {
  level: string;
  message: string;
  fields: {};
  _time: string;
  request?: RequestReport;
  platform?: PlatformInfo;
  vercel?: PlatformInfo;
  netlify?: NetlifyInfo;
}

export enum LogLevel {
  debug = 0,
  info = 1,
  warn = 2,
  error = 3,
  off = 100,
}

export interface RequestReport {
  startTime: number;
  statusCode?: number;
  ip?: string | null;
  region?: string | null;
  path: string;
  host?: string | null;
  method: string;
  scheme: string;
  userAgent?: string | null;
}

export interface PlatformInfo {
  environment?: string;
  region?: string;
  route?: string;
  source?: string;
}

export type LoggerConfig = {
  args?: { [key: string]: any };
  logLevel?: LogLevel;
  source?: string;
  req?: any;
};

export class Logger {
  children: Logger[] = [];
  client: Client;

  public logLevel: string;
  public config: LoggerConfig = {
    // default config
    source: 'frontend',
    logLevel: LogLevel.debug,
  };

  constructor(public initConfig: LoggerConfig = {}, public clientOpts?: ClientOptions) {
    this.config = { ...this.config, ...initConfig };
    this.logLevel = this.config.logLevel ? this.config.logLevel.toString() : LOG_LEVEL || 'debug';
    if (!clientOpts) {
      clientOpts = {
        token: configurator.token,
        url: configurator.axiomUrl,
      };
    }
    clientOpts.sdk = 'next-axiom/v' + Version;
    this.client = new Client(clientOpts);
  }

  debug = (message: string, args: { [key: string]: any } = {}) => {
    this._log('debug', message, args);
  };
  info = (message: string, args: { [key: string]: any } = {}) => {
    this._log('info', message, args);
  };
  warn = (message: string, args: { [key: string]: any } = {}) => {
    this._log('warn', message, args);
  };
  error = (message: string, args: { [key: string]: any } = {}) => {
    this._log('error', message, args);
  };

  with = (config: LoggerConfig) => {
    const newConfig = {...this.config, ...config };
    const child = new Logger(newConfig, this.clientOpts);
    this.children.push(child);
    return child;
  };

  withArgs = (args: { [key: string]: any }) => {
    const config = { ...this.config, args: { ...this.config.args, ...args } };
    const child = new Logger(config, this.clientOpts);
    this.children.push(child);
    return child;
  };

  withRequest = (req: any) => {
    return new Logger({ ...this.config, req: { ...this.config.req, ...req } }, this.clientOpts);
  };

  _log = (level: string, message: string, args: { [key: string]: any } = {}) => {
    if (LogLevel[level] < LogLevel[this.logLevel]) {
      return;
    }
    const logEvent: LogEvent = {
      level,
      message,
      _time: new Date(Date.now()).toISOString(),
      fields: this.config.args || {},
    };

    // check if passed args is an object, if its not an object, add it to fields.args
    if (args instanceof Error) {
      logEvent.fields = { ...logEvent.fields, message: args.message, stack: args.stack, name: args.name };
    } else if (typeof args === 'object' && args !== null && Object.keys(args).length > 0) {
      const parsedArgs = JSON.parse(JSON.stringify(args, jsonFriendlyErrorReplacer));
      logEvent.fields = { ...logEvent.fields, ...parsedArgs };
    } else if (args && args.length) {
      logEvent.fields = { ...logEvent.fields, args: args };
    }

    configurator.injectPlatformMetadata(logEvent, this.config.source!);

    if (this.config.req != null) {
      logEvent.request = this.config.req;
      if (logEvent.platform) {
        logEvent.platform.route = this.config.req.path;
      } else if (logEvent.vercel) {
        logEvent.vercel.route = this.config.req.path;
      }
    }

    this.ingest(logEvent);
  };

  attachResponseStatus = (statusCode: number) => {
    // FIXME: how to attach data to queued logs?
    // this.logEvents = this.logEvents.map((log) => {
    //   if (log.request) {
    //     log.request.statusCode = statusCode;
    //   }
    //   return log;
    // });
  };

  private ingest(ev: LogEvent) {
    if (!configurator.isEnvVarsSet()) {
      // if AXIOM ingesting url is not set, fallback to printing to console
      // to avoid network errors in development environments
      prettyPrint(ev);
      return;
    }

    // FIXME: this is a hack to get around the fact that we don't have a way to ensure we have a dataset name
    try {
      return this.client.ingest(configurator.dataset || 'vercel', ev);
    } catch (err: any) {
      // swallow errors
      console.warn(err);
    }
  }

  flush = async () => {
    try {
      return await this.client.flush();
    } catch (err: any) {
      console.warn(err);
      // swallow errors
      return Promise.resolve();
    }
  };
}

const levelColors: { [key: string]: any } = {
  info: {
    terminal: '32',
    browser: 'lightgreen',
  },
  debug: {
    terminal: '36',
    browser: 'lightblue',
  },
  warn: {
    terminal: '33',
    browser: 'yellow',
  },
  error: {
    terminal: '31',
    browser: 'red',
  },
};

export function prettyPrint(ev: LogEvent) {
  const hasFields = Object.keys(ev.fields).length > 0;
  // check whether pretty print is disabled
  if (isNoPrettyPrint) {
    let msg = `${ev.level} - ${ev.message}`;
    if (hasFields) {
      msg += ' ' + JSON.stringify(ev.fields);
    }
    console.log(msg);
    return;
  }
  // print indented message, instead of [object]
  // We use the %o modifier instead of JSON.stringify because stringify will print the
  // object as normal text, it loses all the functionality the browser gives for viewing
  // objects in the console, such as expanding and collapsing the object.
  let msgString = '';
  let args: any[] = [ev.level, ev.message];

  if (configurator.isBrowser) {
    msgString = '%c%s - %s';
    args = [`color: ${levelColors[ev.level].browser};`, ...args];
  } else {
    msgString = `\x1b[${levelColors[ev.level].terminal}m%s\x1b[0m - %s`;
  }
  // we check if the fields object is not empty, otherwise its printed as <empty string>
  // or just "".
  if (hasFields) {
    msgString += ' %o';
    args.push(ev.fields);
  }

  if (ev.request) {
    msgString += ' %o';
    args.push(ev.request);
  }

  console.log.apply(console, [msgString, ...args]);
}

function jsonFriendlyErrorReplacer(key: string, value: any) {
  if (value instanceof Error) {
    return {
      // Pull all enumerable properties, supporting properties on custom Errors
      ...value,
      // Explicitly pull Error's non-enumerable properties
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  return value;
}
