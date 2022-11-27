import * as cp from 'child_process';
import { documents} from './server';

import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import antlr4 from './parser/antlr4/index.js';
import CMakeLexer from "./parser/CMakeLexer";
import CMakeParser from "./parser/CMakeParser";
import InputStream from './parser/antlr4/InputStream';
import { URI, Utils } from 'vscode-uri';
import { cmakeInfo } from './cmakeInfo';

// export type Entries = [string, string, string, string];

// export type CMakeVersion = {
//     version: string,
//     major: number,
//     minor: number,
//     patch: number
// };

// export let cmakeVersion: CMakeVersion = getCMakeVersion();

// export function getBuiltinEntries(): Entries {
//     if (extSettings === undefined) {
//         getConfiguration();
//     }
//     const args = [extSettings[ExtSettings.cmakePath], '--help-module-list', '--help-policy-list',
//         '--help-variable-list', '--help-property-list'];
//     const cmd: string = args.join(' ');
//     // TODO: execute command async
//     const output = cp.execSync(cmd, { encoding: 'utf-8' });
//     return output.trim().split('\n\n\n') as Entries;
// }

// export function getCMakeVersion(): CMakeVersion {
//     const args = [extSettings[ExtSettings.cmakePath], '--version'];
//     const output: string = cp.execSync(args.join(' '), { encoding: 'utf-8' });
//     const regexp: RegExp = /(\d+)\.(\d+)\.(\d+)/;
//     const res = output.match(regexp);
//     return {
//         version: res[0],
//         major: parseInt(res[1]),
//         minor: parseInt(res[2]),
//         patch: parseInt(res[3])
//     };
// }

export function getFileContext(uri: URI) {
    const document = documents.get(uri.toString());
    let text: string;
    if (document) {
        text = document.getText();
    } else {
        text = fs.readFileSync(uri.fsPath, { encoding: 'utf-8' });
    }
    const input: InputStream = antlr4.CharStreams.fromString(text);
    const lexer = new CMakeLexer(input);
    const tokenStream = new antlr4.CommonTokenStream(lexer);
    const parser = new CMakeParser(tokenStream);
    return parser.file();
}

export function getSubCMakeListsUri(baseDir: URI, subDir: string): URI {
    const subCMakeListsUri: URI = Utils.joinPath(baseDir, subDir, 'CMakeLists.txt');
    if (existsSync(subCMakeListsUri.fsPath)) {
        return subCMakeListsUri;
    }

    return null;
}

export function getIncludeFileUri(baseDir: URI, includeFileName: string): URI {
    const incFileUri: URI = Utils.joinPath(baseDir, includeFileName);
    if (existsSync(incFileUri.fsPath)) {
        return incFileUri;
    }

    const cmakePath: string = which('cmake');
    if (cmakePath === null) {
        return null;
    }

    const moduleDir = 'cmake-' + cmakeInfo.major + '.' + cmakeInfo.minor;
    const resPath = path.join(cmakePath, '../..', 'share', moduleDir, 'Modules', includeFileName) + '.cmake';

    if (existsSync(resPath)) {
        // return pathToFileURL(resPath).toString();
        return URI.file(resPath);
    }

    return null;
}

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
