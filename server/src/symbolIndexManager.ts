import { hydrateBuiltinModuleCacheEntry } from './builtinModuleIndex';
import { isCancellationError, throwIfCancelled } from './cancellation';
import { SymbolIndex } from './symbolIndex';

type DependencyErrorAction = 'continue' | 'throw';

export interface PopulateIndexTopDownOptions {
    rootUri: string;
    entryFile?: string;
    symbolIndex: SymbolIndex;
    loadFlatCommands: (uri: string) => Promise<unknown>;
    ensureFileIndexed?: (uri: string, entryFile: string) => Promise<boolean>;
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
    ensureFileIndexed?: (uri: string, entryFile: string) => Promise<boolean>,
): Promise<boolean> {
    const existingCache = symbolIndex.getCache(uri);
    const isContextFreeCache = existingCache && symbolIndex.getCacheRevisionKey(uri) === undefined;
    if (isContextFreeCache) {
        return true;
    }
    if (existingCache && ensureFileIndexed) {
        return ensureFileIndexed(uri, entryFile);
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
            return ensureFileIndexed(uri, entryFile);
        }
        await loadFlatCommands(uri);
    }

    return hydrated || isUsableCache();
}

export async function populateIndexTopDown(options: PopulateIndexTopDownOptions): Promise<void> {
    const visited = options.visited ?? new Set<string>();
    const stack = [options.rootUri];
    const entryFile = options.entryFile ?? options.rootUri;

    while (stack.length > 0) {
        throwIfCancelled(options.shouldCancel);
        const uri = stack.pop()!;
        if (visited.has(uri)) {
            continue;
        }
        visited.add(uri);

        try {
            const cacheAvailable = await ensureSymbolIndexCache(
                options.symbolIndex,
                options.loadFlatCommands,
                uri,
                entryFile,
                options.shouldCancel,
                options.ensureFileIndexed,
            );
            if (!cacheAvailable) {
                continue;
            }
            throwIfCancelled(options.shouldCancel);
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }

            const action = await options.onDependencyError?.(uri, error) ?? 'throw';
            if (action === 'continue') {
                continue;
            }
            throw error;
        }

        const dependencies = options.symbolIndex.getAvailableDependencies(uri, entryFile);
        for (let index = dependencies.length - 1; index >= 0; index--) {
            stack.push(dependencies[index].uri);
        }
    }
}
