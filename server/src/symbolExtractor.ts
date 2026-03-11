import * as fs from 'fs';
import { URI, Utils } from 'vscode-uri';
import { FlatCommand } from './flatCommands';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from './symbolIndex';
import { getIncludeFileUri } from './utils';

export function extractSymbols(
    uri: string,
    commands: FlatCommand[],
    baseDir: URI,
    symbolIndex: SymbolIndex
): FileSymbolCache {
    const cache = new FileSymbolCache(uri);

    for (const cmd of commands) {
        const cmdName = cmd.commandName.toLowerCase();

        switch (cmdName) {
            case 'function':
                extractFunctionOrMacro(cmd, SymbolKind.Function, cache, uri);
                break;
            case 'macro':
                extractFunctionOrMacro(cmd, SymbolKind.Macro, cache, uri);
                break;
            case 'set':
            case 'option':
                extractVariable(cmd, cache, uri);
                break;
            case 'add_executable':
            case 'add_library':
                extractTarget(cmd, cache, uri);
                break;
            case 'include':
                extractInclude(cmd, cache, baseDir, symbolIndex);
                break;
            case 'add_subdirectory':
                extractAddSubdirectory(cmd, cache, baseDir);
                break;
        }
    }

    return cache;
}

function extractFunctionOrMacro(cmd: FlatCommand, kind: SymbolKind, cache: FileSymbolCache, uri: string) {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const token = args[0].start;
        if (token) {
            const symbol = new Symbol(token.text, kind, uri, token.line - 1, token.column);
            cache.addCommand(symbol);
        }
    }
}

function extractVariable(cmd: FlatCommand, cache: FileSymbolCache, uri: string) {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const token = args[0].start;
        if (token) {
            const symbol = new Symbol(token.text, SymbolKind.Variable, uri, token.line - 1, token.column);
            cache.addVariable(symbol);
        }
    }
}

function extractTarget(cmd: FlatCommand, cache: FileSymbolCache, uri: string) {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const token = args[0].start;
        if (token) {
            const symbol = new Symbol(token.text, SymbolKind.Target, uri, token.line - 1, token.column);
            cache.addTarget(symbol);
        }
    }
}

function extractInclude(cmd: FlatCommand, cache: FileSymbolCache, baseDir: URI, symbolIndex: SymbolIndex) {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const nameToken = args[0].start;
        if (nameToken) {
            const incUri = getIncludeFileUri(symbolIndex, baseDir, nameToken.text);
            if (incUri) {
                cache.addDependency(incUri.toString(), 'include');
            }
        }
    }
}

function extractAddSubdirectory(cmd: FlatCommand, cache: FileSymbolCache, baseDir: URI) {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const dirToken = args[0].start;
        if (dirToken) {
            const subDir = dirToken.text;
            const subCMakeListsUri = Utils.joinPath(baseDir, subDir, 'CMakeLists.txt');
            if (fs.existsSync(subCMakeListsUri.fsPath)) {
                cache.addDependency(subCMakeListsUri.toString(), 'subdirectory');
            }
        }
    }
}
