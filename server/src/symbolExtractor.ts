import * as fs from 'fs';
import * as path from 'path';
import { URI, Utils } from 'vscode-uri';
import { FlatCommand } from './flatCommands';
import { PathExpressionResolver } from './pathExpressionResolver';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from './symbolIndex';
import { getIncludeFileUri } from './utils';

export interface ExtractSymbolsOptions {
    entryFile: string;
    getFlatCommands: (uri: string) => Promise<FlatCommand[]>;
}

export async function extractSymbols(
    uri: string,
    commands: FlatCommand[],
    baseDir: URI,
    symbolIndex: SymbolIndex,
    options?: ExtractSymbolsOptions,
): Promise<FileSymbolCache> {
    const cache = new FileSymbolCache(uri);
    const pathExpressionResolver = options
        ? new PathExpressionResolver({
            symbolIndex,
            getFlatCommands: options.getFlatCommands,
            entryFile: URI.parse(options.entryFile),
        })
        : undefined;

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
            case 'foreach':
                extractForeachVariable(cmd, cache, uri);
                break;
            case 'add_executable':
            case 'add_library':
                extractTarget(cmd, cache, uri);
                break;
            case 'include':
                await extractInclude(cmd, cache, baseDir, symbolIndex, URI.parse(uri), pathExpressionResolver);
                break;
            case 'add_subdirectory':
                await extractAddSubdirectory(cmd, cache, baseDir, URI.parse(uri), pathExpressionResolver);
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

async function extractInclude(
    cmd: FlatCommand,
    cache: FileSymbolCache,
    baseDir: URI,
    symbolIndex: SymbolIndex,
    sourceUri: URI,
    pathExpressionResolver?: PathExpressionResolver,
) {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const includeArg = args[0];
        const includeText = includeArg?.getText();
        const maxLine = includeArg?.start.line ? includeArg.start.line - 1 : 0;
        if (!includeText) {
            return;
        }

        const incUri = pathExpressionResolver
            ? await pathExpressionResolver.resolveFileExpression(includeText, sourceUri, maxLine)
            : null;
        const fallbackUri = getIncludeFileUri(symbolIndex, baseDir, includeText);
        const targetUri = incUri ?? fallbackUri;
        if (targetUri) {
            cache.addDependency(targetUri.toString(), 'include');
        }
    }
}

async function extractAddSubdirectory(
    cmd: FlatCommand,
    cache: FileSymbolCache,
    baseDir: URI,
    sourceUri: URI,
    pathExpressionResolver?: PathExpressionResolver,
) {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const dirArg = args[0];
        const dirText = dirArg?.getText();
        const maxLine = dirArg?.start.line ? dirArg.start.line - 1 : 0;
        if (!dirText) {
            return;
        }

        const expandedDir = pathExpressionResolver
            ? await pathExpressionResolver.expandPathVariables(dirText, sourceUri, maxLine)
            : dirText;
        if (!expandedDir) {
            return;
        }

        const subCMakeListsUri = path.isAbsolute(expandedDir)
            ? URI.file(path.join(path.normalize(expandedDir), 'CMakeLists.txt'))
            : Utils.joinPath(baseDir, expandedDir.replace(/\\/g, '/'), 'CMakeLists.txt');
        if (fs.existsSync(subCMakeListsUri.fsPath)) {
            cache.addDependency(subCMakeListsUri.toString(), 'subdirectory');
        }
    }
}

// The first argument to foreach() is always the loop variable, regardless of the loop form
// (foreach(VAR ...), foreach(VAR RANGE n), foreach(VAR IN LISTS/ITEMS ...)).
function extractForeachVariable(cmd: FlatCommand, cache: FileSymbolCache, uri: string) {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const token = args[0].start;
        if (token) {
            const symbol = new Symbol(token.text, SymbolKind.Variable, uri, token.line - 1, token.column);
            cache.addVariable(symbol);
        }
    }
}
