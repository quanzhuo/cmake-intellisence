import { CharStream, CharStreams, CommonTokenStream } from 'antlr4';
import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI, Utils } from 'vscode-uri';
import CMakeLexer from './generated/CMakeLexer';
import CMakeParser, { FileContext } from './generated/CMakeParser';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver';
import { CMakeInfo } from './cmakeInfo';
import { logger } from './server';
import * as cmsp from './generated/CMakeSimpleParser';
import * as cmsl from './generated/CMakeSimpleLexer';
import CMakeSimpleLexer from './generated/CMakeSimpleLexer';
import CMakeSimpleParser from './generated/CMakeSimpleParser';

export function getSimpleFileContext(text: string): cmsp.FileContext {
    const input: CharStream = CharStreams.fromString(text);
    const lexer = new CMakeSimpleLexer(input);
    const tokenStream = new CommonTokenStream(lexer);
    const parser = new CMakeSimpleParser(tokenStream);
    return parser.file();
}

// export function getFileContext(text: string): FileContext {
//     const input: CharStream = CharStreams.fromString(text);
//     const lexer = new CMakeLexer(input);
//     const tokenStream = new CommonTokenStream(lexer);
//     const parser = new CMakeParser(tokenStream);
//     return parser.file();
// }

export function getFileContext(documents: TextDocuments<TextDocument>, uri: URI): FileContext {
    const document = documents.get(uri.toString());
    let text: string;
    if (document) {
        text = document.getText();
    } else {
        text = readFileSync(uri.fsPath, { encoding: 'utf-8' });
    }
    const input: CharStream = CharStreams.fromString(text);
    const lexer = new CMakeLexer(input);
    const tokenStream = new CommonTokenStream(lexer);
    const parser = new CMakeParser(tokenStream);
    return parser.file();
}

export function getSubCMakeListsUri(baseDir: URI, subDir: string): URI {
    const subCMakeListsUri: URI = Utils.joinPath(baseDir, subDir, 'CMakeLists.txt');
    if (existsSync(subCMakeListsUri.fsPath)) {
        return subCMakeListsUri;
    } else {
        logger.error('getSubCMakeListsUri:', subCMakeListsUri.fsPath, 'not exist');
    }

    return null;
}

export function getIncludeFileUri(cmakeInfo: CMakeInfo, baseDir: URI, includeFileName: string): URI {
    const incFileUri: URI = Utils.joinPath(baseDir, includeFileName);
    if (existsSync(incFileUri.fsPath)) {
        return incFileUri;
    } else {
        logger.error('getIncludeFileUri:', incFileUri.fsPath, 'not exist');
    }

    // const cmakePath: string = which('cmake');
    // if (cmakePath === null) {
    //     return null;
    // }

    const moduleDir = 'cmake-' + cmakeInfo.major + '.' + cmakeInfo.minor;
    const resPath = path.join(cmakeInfo.cmakePath, '../..', 'share', moduleDir, 'Modules', includeFileName) + '.cmake';

    if (existsSync(resPath)) {
        // return pathToFileURL(resPath).toString();
        return URI.file(resPath);
    } else {
        logger.error('getIncludeFileUri:', resPath, 'not exist');
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
