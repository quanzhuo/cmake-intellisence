import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';

export function which(cmd: string): string {
    let command: string;
    let pathEnvSep: string;
    if (os.type() === 'Windows_NT') {
        if (!cmd.endsWith('.exe')) {
            command = cmd + ".exe";
        }
        pathEnvSep = ';';
    } else {
        command = cmd;
        pathEnvSep = ':';
    }

    for (const dir of process.env.PATH.split(pathEnvSep)) {
        const absPath: string = dir + path.sep + command;
        if (existsSync(absPath)) {
            return absPath;
        }
    }

    return null;
}