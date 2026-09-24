import * as path from 'path';
import { URI } from 'vscode-uri';
import { hydrateBuiltinModuleCacheEntry } from './builtinModuleIndex';
import { isCancellationError, throwIfCancelled } from './cancellation';
import { PathExpressionResolver } from './pathExpressionResolver';
import { SymbolIndex } from './symbolIndex';

type DependencyErrorAction = 'continue' | 'throw';

export interface PopulateIndexTopDownOptions {
    rootUri: string;
    entryFile?: string;
    symbolIndex: SymbolIndex;
    loadFlatCommands: (uri: string) => Promise<unknown>;
    ensureFileIndexed?: (uri: string, entryFile: string, sourceDirectory: string) => Promise<boolean>;
    shouldCancel?: () => boolean;
    visited?: Set<string>;
    onDependencyError?: (uri: string, error: unknown) => DependencyErrorAction | Promise<DependencyErrorAction>;
}

export async function ensureSymbolIndexCache(
    symbolIndex: SymbolIndex,
    loadFlatCommands: (uri: string) => Promise<unknown>,
    uri: string,
    entryFile: string,
    shouldCancel?: () => boolean,
    ensureFileIndexed?: (uri: string, entryFile: string, sourceDirectory: string) => Promise<boolean>,
    sourceDirectory = path.dirname(URI.parse(uri).fsPath),
): Promise<boolean> {
    const existingCache = symbolIndex.getCache(uri);
    const isContextFreeCache = existingCache && symbolIndex.getCacheRevisionKey(uri) === undefined;
    if (isContextFreeCache) {
        return true;
    }
    if (existingCache && ensureFileIndexed) {
        return ensureFileIndexed(uri, entryFile, sourceDirectory);
    }
    const isUsableCache = (): boolean => !!symbolIndex.getCache(uri)
        && symbolIndex.hasDependencyContext(uri, entryFile);
    if (isUsableCache()) {
        return true;
    }

    let hydrated = false;
    if (symbolIndex.cmakeModulePath) {
        hydrated = await hydrateBuiltinModuleCacheEntry({
            symbolIndex,
            cmakePath: symbolIndex.cmakePath,
            cmakeFingerprint: symbolIndex.cmakeFingerprint,
            cmakeModulePath: symbolIndex.cmakeModulePath,
        }, uri);
    }

    if (!hydrated) {
        throwIfCancelled(shouldCancel);
        if (ensureFileIndexed) {
            return ensureFileIndexed(uri, entryFile, sourceDirectory);
        }
        await loadFlatCommands(uri);
    }

    return hydrated || isUsableCache();
}

export async function populateIndexTopDown(options: PopulateIndexTopDownOptions): Promise<void> {
    const visited = options.visited ?? new Set<string>();
    const entryFile = options.entryFile ?? options.rootUri;
    const rootDirectory = options.symbolIndex.getSourceDirectoryContext(entryFile, options.rootUri)
        ?? new PathExpressionResolver({
            symbolIndex: options.symbolIndex,
            getFlatCommands: async () => [],
            entryFile: URI.parse(entryFile),
        }).getCurrentSourceDirectory(URI.parse(options.rootUri));
    const stack = [{ uri: options.rootUri, sourceDirectory: rootDirectory }];

    while (stack.length > 0) {
        throwIfCancelled(options.shouldCancel);
        const { uri, sourceDirectory } = stack.pop()!;
        if (visited.has(uri)) {
            continue;
        }
        visited.add(uri);
        options.symbolIndex.setSourceDirectoryContext(entryFile, uri, sourceDirectory);

        try {
            const cacheAvailable = await ensureSymbolIndexCache(
                options.symbolIndex,
                options.loadFlatCommands,
                uri,
                entryFile,
                options.shouldCancel,
                options.ensureFileIndexed,
                sourceDirectory,
            );
            if (!cacheAvailable) {
                options.symbolIndex.deleteSourceDirectoryContext(entryFile, uri);
                continue;
            }
            options.symbolIndex.setSourceDirectoryContext(entryFile, uri, sourceDirectory);
            throwIfCancelled(options.shouldCancel);
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }

            const action = await options.onDependencyError?.(uri, error) ?? 'throw';
            if (action === 'continue') {
                options.symbolIndex.deleteSourceDirectoryContext(entryFile, uri);
                continue;
            }
            throw error;
        }

        const dependencies = options.symbolIndex.getAvailableDependencies(uri, entryFile);
        for (let index = dependencies.length - 1; index >= 0; index--) {
            const dependency = dependencies[index];
            stack.push({
                uri: dependency.uri,
                sourceDirectory: dependency.type === 'subdirectory'
                    ? path.dirname(URI.parse(dependency.uri).fsPath)
                    : sourceDirectory,
            });
        }
    }
}
