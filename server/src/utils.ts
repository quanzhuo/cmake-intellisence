import * as cp from 'child_process';
import { documents } from './server';

import { existsSync, fstat } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import antlr4 from './parser/antlr4/index.js';
import CMakeLexer from "./parser/CMakeLexer";
import CMakeParser from "./parser/CMakeParser";
import InputStream from './parser/antlr4/InputStream';

export type Entries = [string, string, string, string];

export type CMakeVersion = {
    version: string,
    major: number,
    minor: number,
    patch: number
};

export let cmakeVersion: CMakeVersion = getCMakeVersion();

export function getBuiltinEntries(): Entries {
    const args = ['cmake', '--help-module-list', '--help-policy-list',
        '--help-variable-list', '--help-property-list'];
    const cmd: string = args.join(' ');
    const output = cp.execSync(cmd, { encoding: 'utf-8' });
    return output.trim().split('\n\n\n') as Entries;
}

export function getCMakeVersion(): CMakeVersion {
    const args = ['cmake', '--version'];
    const output: string = cp.execSync(args.join(' '), { encoding: 'utf-8' });
    const regexp: RegExp = /(\d+)\.(\d+)\.(\d+)/;
    const res = output.match(regexp);
    return {
        version: res[0],
        major: parseInt(res[1]),
        minor: parseInt(res[2]),
        patch: parseInt(res[3])
    };
}

export function getFileContext(uri: string) {
    const document = documents.get(uri);
    let text: string;
    if (document) {
        text = document.getText();
    } else {
        text = fs.readFileSync(fileURLToPath(uri), { encoding: 'utf-8' });
    }
    const input: InputStream = antlr4.CharStreams.fromString(text);
    const lexer = new CMakeLexer(input);
    const tokenStream = new antlr4.CommonTokenStream(lexer);
    const parser = new CMakeParser(tokenStream);
    return parser.file();
}

export function getIncludeFileUri(currentFileUri: string, includeFileName: string): string {
    const currentFilePath: string = fileURLToPath(currentFileUri);
    const includeFilePath: string = path.dirname(currentFilePath) + path.sep + includeFileName;
    // const includeFileUri: string = filePathToURL;
    if (existsSync(includeFilePath)) {
        const index = currentFileUri.lastIndexOf('/');
        const includeFileUri = currentFileUri.slice(0, index) + path.sep + includeFileName;
        return includeFileUri;
    }

    // name is a cmake module
    const cmakePath: string = which('cmake');
    if (cmakePath === null) {
        return null;
    }

    const moduleDir = 'cmake-' + cmakeVersion.major + '.' + cmakeVersion.minor;
    const resPath = path.join(cmakePath, '..', 'share', moduleDir, 'Modules', includeFileName) + '.cmake';

    return pathToFileURL(resPath).toString();
}

function which(cmd: string): string {
    let command: string;
    if (os.type() === 'Windows_NT') {
        command = cmd + ".exe";
    } else {
        command = cmd;
    }

    for (const dir of process.env.PATH.split(path.sep)) {
        const absPath: string = dir + path.sep + command;
        if (existsSync(absPath)) {
            return absPath;
        }
    }

    return null;
}
