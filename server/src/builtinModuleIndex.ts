import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import paths, { mkdir_p } from './paths';
import { extractSymbols } from './symbolExtractor';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from './symbolIndex';
import { parseCMakeText } from './utils';

const BUILTIN_MODULE_CACHE_VERSION = 1;
const BUILTIN_MODULE_YIELD_INTERVAL = 8;

type SerializedSymbol = {
    name: string;
    kind: number;
    uri: string;
    line: number;
    column: number;
};

type SerializedFileSymbolCache = {
    uri: string;
    commands: SerializedSymbol[];
    variables: SerializedSymbol[];
    targets: SerializedSymbol[];
    modules: SerializedSymbol[];
    policies: SerializedSymbol[];
    properties: SerializedSymbol[];
    dependencies: FileSymbolCache['dependencies'];
};

type PersistedBuiltinModuleEntry = {
    mtimeMs: number;
    size: number;
    cache: SerializedFileSymbolCache;
};

type PersistedBuiltinModuleIndex = {
    cacheVersion: number;
    cmakePath: string;
    cmakeVersion: string;
    cmakeModulePath: string;
    entries: Record<string, PersistedBuiltinModuleEntry>;
};

type PersistedBuiltinModuleCommandCatalog = {
    cacheVersion: number;
    cmakePath: string;
    cmakeVersion: string;
    cmakeModulePath: string;
    commands: string[];
};

const builtinModuleCacheFileMemo = new Map<string, Promise<PersistedBuiltinModuleIndex | null>>();
const builtinModuleCommandCatalogFileMemo = new Map<string, Promise<PersistedBuiltinModuleCommandCatalog | null>>();

export type BuiltinModuleWarmupResult = {
    loadedFromCache: number;
    indexedFresh: number;
};

export interface BuiltinModuleWarmupOptions {
    symbolIndex: SymbolIndex;
    cmakePath: string;
    cmakeVersion: string;
    cmakeModulePath: string;
    shouldCancel?: () => boolean;
}

function flattenSymbols(map: Map<string, Symbol[]>): SerializedSymbol[] {
    const symbols: SerializedSymbol[] = [];
    for (const entries of map.values()) {
        for (const symbol of entries) {
            symbols.push({
                name: symbol.name,
                kind: symbol.kind,
                uri: symbol.uri,
                line: symbol.line,
                column: symbol.column,
            });
        }
    }
    return symbols;
}

export function serializeFileSymbolCache(cache: FileSymbolCache): SerializedFileSymbolCache {
    return {
        uri: cache.uri,
        commands: flattenSymbols(cache.commands),
        variables: flattenSymbols(cache.variables),
        targets: flattenSymbols(cache.targets),
        modules: flattenSymbols(cache.modules),
        policies: flattenSymbols(cache.policies),
        properties: flattenSymbols(cache.properties),
        dependencies: [...cache.dependencies],
    };
}

function restoreSymbols(symbols: SerializedSymbol[], add: (symbol: Symbol) => void): void {
    for (const symbol of symbols) {
        add(new Symbol(symbol.name, symbol.kind, symbol.uri, symbol.line, symbol.column));
    }
}

export function deserializeFileSymbolCache(serialized: SerializedFileSymbolCache): FileSymbolCache {
    const cache = new FileSymbolCache(serialized.uri);
    restoreSymbols(serialized.commands, symbol => cache.addCommand(symbol));
    restoreSymbols(serialized.variables, symbol => cache.addVariable(symbol));
    restoreSymbols(serialized.targets, symbol => cache.addTarget(symbol));
    restoreSymbols(serialized.modules, symbol => cache.addModule(symbol));
    restoreSymbols(serialized.policies, symbol => cache.addPolicy(symbol));
    restoreSymbols(serialized.properties, symbol => cache.addProperty(symbol));
    for (const dependency of serialized.dependencies) {
        cache.addDependency(dependency.uri, dependency.type);
    }
    return cache;
}

function getBuiltinModuleCacheFilePath(cmakePath: string, cmakeVersion: string, cmakeModulePath: string): string {
    const hash = crypto
        .createHash('sha256')
        .update(`${cmakePath}\0${cmakeVersion}\0${cmakeModulePath}`)
        .digest('hex')
        .slice(0, 16);
    return path.join(paths.dataDir, 'builtin-module-cache', `${hash}.json`);
}

function getBuiltinModuleCommandCatalogFilePath(cmakePath: string, cmakeVersion: string, cmakeModulePath: string): string {
    const hash = crypto
        .createHash('sha256')
        .update(`${cmakePath}\0${cmakeVersion}\0${cmakeModulePath}`)
        .digest('hex')
        .slice(0, 16);
    return path.join(paths.dataDir, 'builtin-module-cache', `${hash}.commands.json`);
}

async function readBuiltinModuleCache(options: BuiltinModuleWarmupOptions): Promise<PersistedBuiltinModuleIndex | null> {
    const filePath = getBuiltinModuleCacheFilePath(options.cmakePath, options.cmakeVersion, options.cmakeModulePath);
    const existing = builtinModuleCacheFileMemo.get(filePath);
    if (existing) {
        return existing;
    }

    const request = (async () => {
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(content) as PersistedBuiltinModuleIndex;
            if (
                parsed.cacheVersion !== BUILTIN_MODULE_CACHE_VERSION
                || parsed.cmakePath !== options.cmakePath
                || parsed.cmakeVersion !== options.cmakeVersion
                || parsed.cmakeModulePath !== options.cmakeModulePath
            ) {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    })();

    builtinModuleCacheFileMemo.set(filePath, request);
    try {
        return await request;
    } catch {
        builtinModuleCacheFileMemo.delete(filePath);
        return null;
    }
}

async function writeBuiltinModuleCache(options: BuiltinModuleWarmupOptions, entries: Record<string, PersistedBuiltinModuleEntry>): Promise<void> {
    const filePath = getBuiltinModuleCacheFilePath(options.cmakePath, options.cmakeVersion, options.cmakeModulePath);
    await mkdir_p(path.dirname(filePath));
    const payload: PersistedBuiltinModuleIndex = {
        cacheVersion: BUILTIN_MODULE_CACHE_VERSION,
        cmakePath: options.cmakePath,
        cmakeVersion: options.cmakeVersion,
        cmakeModulePath: options.cmakeModulePath,
        entries,
    };
    await fs.promises.writeFile(filePath, JSON.stringify(payload), 'utf8');
    builtinModuleCacheFileMemo.set(filePath, Promise.resolve(payload));
}

async function readBuiltinModuleCommandCatalog(options: BuiltinModuleWarmupOptions): Promise<PersistedBuiltinModuleCommandCatalog | null> {
    const filePath = getBuiltinModuleCommandCatalogFilePath(options.cmakePath, options.cmakeVersion, options.cmakeModulePath);
    const existing = builtinModuleCommandCatalogFileMemo.get(filePath);
    if (existing) {
        return existing;
    }

    const request = (async () => {
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(content) as PersistedBuiltinModuleCommandCatalog;
            if (
                parsed.cacheVersion !== BUILTIN_MODULE_CACHE_VERSION
                || parsed.cmakePath !== options.cmakePath
                || parsed.cmakeVersion !== options.cmakeVersion
                || parsed.cmakeModulePath !== options.cmakeModulePath
            ) {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    })();

    builtinModuleCommandCatalogFileMemo.set(filePath, request);
    try {
        return await request;
    } catch {
        builtinModuleCommandCatalogFileMemo.delete(filePath);
        return null;
    }
}

async function writeBuiltinModuleCommandCatalog(options: BuiltinModuleWarmupOptions, commands: string[]): Promise<void> {
    const filePath = getBuiltinModuleCommandCatalogFilePath(options.cmakePath, options.cmakeVersion, options.cmakeModulePath);
    await mkdir_p(path.dirname(filePath));
    const payload: PersistedBuiltinModuleCommandCatalog = {
        cacheVersion: BUILTIN_MODULE_CACHE_VERSION,
        cmakePath: options.cmakePath,
        cmakeVersion: options.cmakeVersion,
        cmakeModulePath: options.cmakeModulePath,
        commands,
    };
    await fs.promises.writeFile(filePath, JSON.stringify(payload), 'utf8');
    builtinModuleCommandCatalogFileMemo.set(filePath, Promise.resolve(payload));
}

async function collectBuiltinModuleFiles(modulePath: string): Promise<string[]> {
    const entries = await fs.promises.readdir(modulePath, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.cmake'))
        .map(entry => path.join(modulePath, entry.name))
        .sort((left, right) => left.localeCompare(right));
}

function isPersistedEntryFresh(entry: PersistedBuiltinModuleEntry | undefined, stats: fs.Stats): entry is PersistedBuiltinModuleEntry {
    return entry !== undefined && entry.mtimeMs === stats.mtimeMs && entry.size === stats.size;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function appendBuiltinModuleCommands(
    commands: string[],
    seenCommands: Set<string>,
    serializedSymbols: Iterable<SerializedSymbol>
): void {
    for (const symbol of serializedSymbols) {
        if (symbol.kind !== SymbolKind.Function && symbol.kind !== SymbolKind.Macro) {
            continue;
        }

        const key = symbol.name.toLowerCase();
        if (seenCommands.has(key)) {
            continue;
        }

        seenCommands.add(key);
        commands.push(symbol.name);
    }
}

export async function loadBuiltinModuleCommandCatalog(options: BuiltinModuleWarmupOptions): Promise<string[]> {
    const persisted = await readBuiltinModuleCommandCatalog(options);
    const commands = persisted?.commands ?? [];
    options.symbolIndex.replaceBuiltinModuleCommandCatalog(commands);
    return commands;
}

export async function warmBuiltinModuleCaches(options: BuiltinModuleWarmupOptions): Promise<BuiltinModuleWarmupResult> {
    const persisted = await readBuiltinModuleCache(options);
    const persistedEntries = persisted?.entries ?? {};
    const nextEntries: Record<string, PersistedBuiltinModuleEntry> = {};
    const moduleFiles = await collectBuiltinModuleFiles(options.cmakeModulePath);
    const builtinModuleCommands: string[] = [];
    const seenCommands = new Set<string>();
    let loadedFromCache = 0;
    let indexedFresh = 0;

    for (let index = 0; index < moduleFiles.length; index++) {
        if (options.shouldCancel?.()) {
            break;
        }

        const filePath = moduleFiles[index];
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) {
            continue;
        }

        const uri = URI.file(filePath).toString();
        const persistedEntry = persistedEntries[uri];
        if (isPersistedEntryFresh(persistedEntry, stats)) {
            const cache = deserializeFileSymbolCache(persistedEntry.cache);
            options.symbolIndex.setCache(uri, cache);
            nextEntries[uri] = persistedEntry;
            appendBuiltinModuleCommands(builtinModuleCommands, seenCommands, persistedEntry.cache.commands);
            loadedFromCache++;
        } else {
            const text = await fs.promises.readFile(filePath, 'utf8');
            const parsed = parseCMakeText(text);
            const cache = extractSymbols(uri, parsed.flatCommands, URI.file(path.dirname(filePath)), options.symbolIndex);
            options.symbolIndex.setCache(uri, cache);
            const serializedCache = serializeFileSymbolCache(cache);
            nextEntries[uri] = {
                mtimeMs: stats.mtimeMs,
                size: stats.size,
                cache: serializedCache,
            };
            appendBuiltinModuleCommands(builtinModuleCommands, seenCommands, serializedCache.commands);
            indexedFresh++;
        }

        if ((index + 1) % BUILTIN_MODULE_YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
        }
    }

    if (!options.shouldCancel?.()) {
        options.symbolIndex.replaceBuiltinModuleCommandCatalog(builtinModuleCommands);
        await writeBuiltinModuleCache(options, nextEntries);
        await writeBuiltinModuleCommandCatalog(options, builtinModuleCommands);
    }

    return { loadedFromCache, indexedFresh };
}

export async function hydrateBuiltinModuleCacheEntry(options: BuiltinModuleWarmupOptions, uri: string): Promise<boolean> {
    if (options.symbolIndex.getCache(uri)) {
        return true;
    }

    const persisted = await readBuiltinModuleCache(options);
    const entry = persisted?.entries[uri];
    if (!entry) {
        return false;
    }

    try {
        const stats = await fs.promises.stat(URI.parse(uri).fsPath);
        if (!stats.isFile() || !isPersistedEntryFresh(entry, stats)) {
            return false;
        }
    } catch {
        return false;
    }

    options.symbolIndex.setCache(uri, deserializeFileSymbolCache(entry.cache));
    return true;
}