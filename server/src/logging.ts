/**
 * Logging utilities
 * copy from vscode-cmake-tools
 */

import * as node_fs from 'fs';
import * as path from 'path';

/** Logging levels */
export enum LogLevel {
    Debug,
    Info,
    Warning,
    Error,
    Off,
}

type LogLevelKey = 'debug' | 'info' | 'warning' | 'error' | 'off';

/**
 * Get the name of a logging level
 * @param level A logging level
 */
function levelName(level: LogLevel): LogLevelKey {
    switch (level) {
        case LogLevel.Debug:
            return 'debug';
        case LogLevel.Info:
            return 'info';
        case LogLevel.Warning:
            return 'warning';
        case LogLevel.Error:
            return 'error';
        case LogLevel.Off:
            return 'off';
    }
}

/**
 * Determine if logging is enabled for the given LogLevel
 * @param level The log level to check
 */
function levelEnabled(level: LogLevel): boolean {
    // const strlevel = vscode.workspace.getConfiguration('cmake').get<LogLevelKey>('loggingLevel', 'info');
    const strLevel = extSettings.loggingLevel;
    switch (strLevel) {
        case 'debug':
            return level >= LogLevel.Debug;
        case 'info':
            return level >= LogLevel.Info;
        case 'warning':
            return level >= LogLevel.Warning;
        case 'error':
            return level >= LogLevel.Error;
        case 'off':
            return level >= LogLevel.Off;
        default:
            console.error('Invalid logging level in settings.json');
            return true;
    }
}

export interface Stringable {
    toString(): string;
    toLocaleString(): string;
}

let _LOGGER: NodeJS.WritableStream;

export function logFilePath(): string {
    return path.join(paths.dataDir, 'log.txt');
}

async function _openLogFile() {
    if (!_LOGGER) {
        const fpath = logFilePath();
        await mkdir_p(path.dirname(fpath));
        if (await exists(fpath)) {
            _LOGGER = node_fs.createWriteStream(fpath, { flags: 'r+' });
        } else {
            _LOGGER = node_fs.createWriteStream(fpath, { flags: 'w' });
        }
    }
    return _LOGGER;
}

/**
 * Manages and controls logging
 */
class SingletonLogger {
    private readonly _logStream = _openLogFile();

    private _log(level: LogLevel, ...args: Stringable[]) {

        if (!levelEnabled(level)) {
            return;
        }

        const user_message = args.map(a => a.toString()).join(' ');
        const prefix = new Date().toISOString() + ` [${levelName(level)}]`;
        const raw_message = `${prefix} ${user_message}`;
        switch (level) {
            // case LogLevel.Trace:
            case LogLevel.Debug:
            case LogLevel.Info:
                // case LogLevel.Note:
                if (process.env['CMT_QUIET_CONSOLE'] !== '1') {
                    console.info('[cmake-intellisence]', raw_message);
                }
                break;
            case LogLevel.Warning:
                console.warn('[cmake-intellisence]', raw_message);
                break;
            case LogLevel.Error:
                console.error('[cmake-intellisence]', raw_message);
                break;
        }
        // Write to the logfile asynchronously.
        this._logStream.then(strm => strm.write(raw_message + '\n')).catch(e => {
            console.error('Unhandled error while writing cmake-intellisence log file', e);
        });
    }

    debug(...args: Stringable[]) {
        this._log(LogLevel.Debug, ...args);
    }

    info(...args: Stringable[]) {
        this._log(LogLevel.Info, ...args);
    }

    warning(...args: Stringable[]) {
        this._log(LogLevel.Warning, ...args);
    }

    error(...args: Stringable[]) {
        this._log(LogLevel.Error, ...args);
    }

    private static _inst: SingletonLogger | null = null;

    static instance(): SingletonLogger {
        if (SingletonLogger._inst === null) {
            SingletonLogger._inst = new SingletonLogger();
        }
        return SingletonLogger._inst;
    }
}

export class Logger {
    constructor(readonly _tag: string) { }
    get tag() {
        return `[${this._tag}]`;
    }

    debug(...args: Stringable[]) {
        SingletonLogger.instance().debug(this.tag, ...args);
    }

    info(...args: Stringable[]) {
        SingletonLogger.instance().info(this.tag, ...args);
    }

    warning(...args: Stringable[]) {
        SingletonLogger.instance().warning(this.tag, ...args);
    }

    error(...args: Stringable[]) {
        SingletonLogger.instance().error(this.tag, ...args);
    }

    static logTestName(suite?: string, test?: string) {
        SingletonLogger.instance().info('-----------------------------------------------------------------------');
        SingletonLogger.instance().info(`Beginning test: ${suite ?? 'unknown suite'} - ${test ?? 'unknown test'}`);
    }
}

export function createLogger(tag: string) {
    return new Logger(tag);
}

import paths, { mkdir_p, exists } from './paths';
import { extSettings } from './settings';
