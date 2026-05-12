import { existsSync } from 'fs';
import { Location } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

function pathSeparatorFor(fsPath: string): '\\' | '/' {
    return fsPath.includes('\\') ? '\\' : '/';
}

const DEFAULT_MAX_FILE_CACHES = 2048;
const MAX_VISIBLE_FILES_DEPTH = 100;

export enum SymbolKind {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Function,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Variable,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Macro,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Module,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Policy,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Property,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    BuiltinCommand,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    BuiltinVariable,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Target
}

export class Symbol {
    constructor(
        public name: string,
        public kind: SymbolKind,
        public uri: string,
        public line: number,
        public column: number
    ) { }

    getLocation(): Location {
        return {
            uri: this.uri,
            range: {
                start: {
                    line: this.line,
                    character: this.column,
                },
                end: {
                    line: this.line,
                    character: this.column + this.name.length
                }
            }
        };
    }
}

export type DependencyType = 'include' | 'subdirectory';

export interface Dependency {
    uri: string;
    type: DependencyType;
}

/**
 * Cached symbols and dependencies for a single CMake file.
 */
export class FileSymbolCache {
    // CMake commands (functions and macros) are case-insensitive.
    // Keys MUST be lowercase for proper lookup.
    public readonly commands: Map<string, Symbol[]> = new Map();

    // CMake variables are case-sensitive.
    public readonly variables: Map<string, Symbol[]> = new Map();

    // Target names are case-sensitive.
    public readonly targets: Map<string, Symbol[]> = new Map();

    public readonly modules: Map<string, Symbol[]> = new Map();
    public readonly policies: Map<string, Symbol[]> = new Map();
    public readonly properties: Map<string, Symbol[]> = new Map();

    // Dependencies in exact order of declaration
    public readonly dependencies: Dependency[] = [];

    constructor(public uri: string) { }

    addCommand(symbol: Symbol) {
        const key = symbol.name.toLowerCase();
        if (!this.commands.has(key)) {
            this.commands.set(key, []);
        }
        this.commands.get(key)!.push(symbol);
    }

    addVariable(symbol: Symbol) {
        if (!this.variables.has(symbol.name)) {
            this.variables.set(symbol.name, []);
        }
        this.variables.get(symbol.name)!.push(symbol);
    }

    addTarget(symbol: Symbol) {
        if (!this.targets.has(symbol.name)) {
            this.targets.set(symbol.name, []);
        }
        this.targets.get(symbol.name)!.push(symbol);
    }

    addModule(symbol: Symbol) {
        if (!this.modules.has(symbol.name)) {
            this.modules.set(symbol.name, []);
        }
        this.modules.get(symbol.name)!.push(symbol);
    }

    addPolicy(symbol: Symbol) {
        if (!this.policies.has(symbol.name)) {
            this.policies.set(symbol.name, []);
        }
        this.policies.get(symbol.name)!.push(symbol);
    }

    addProperty(symbol: Symbol) {
        if (!this.properties.has(symbol.name)) {
            this.properties.set(symbol.name, []);
        }
        this.properties.get(symbol.name)!.push(symbol);
    }

    addDependency(uri: string, type: DependencyType) {
        this.dependencies.push({ uri, type });
    }
}

/**
 * Global index holding the symbol caches of all parsed files in the workspace.
 */
export class SymbolIndex {
    public cmakePath: string = '';
    public cmakeFingerprint: string = '';
    public cmakeModulePath: string | undefined;
    public pkgConfigPath: string = '';
    public pkgConfigModules: Map<string, string> = new Map();
    private fileCaches: Map<string, FileSymbolCache> = new Map();
    private systemCache: FileSymbolCache = new FileSymbolCache('cmake-builtin://system');
    private builtinModuleCommandCatalog: Map<string, string> = new Map();

    constructor(private readonly maxFileCaches: number = DEFAULT_MAX_FILE_CACHES) {
    }

    setSystemCache(cache: FileSymbolCache): void {
        this.systemCache = cache;
    }

    replaceBuiltinModuleCommandCatalog(commands: Iterable<string>): void {
        this.builtinModuleCommandCatalog.clear();
        for (const command of commands) {
            const key = command.toLowerCase();
            if (!this.builtinModuleCommandCatalog.has(key)) {
                this.builtinModuleCommandCatalog.set(key, command);
            }
        }
    }

    clearBuiltinModuleCommandCatalog(): void {
        this.builtinModuleCommandCatalog.clear();
    }

    private isBuiltinModuleUri(uri: string): boolean {
        if (!this.cmakeModulePath || !uri.startsWith('file://')) {
            return false;
        }

        const moduleRoot = URI.file(this.cmakeModulePath).fsPath;
        const fsPath = URI.parse(uri).fsPath;
        return fsPath === moduleRoot || fsPath.startsWith(`${moduleRoot}${pathSeparatorFor(moduleRoot)}`);
    }

    getSystemCache(): FileSymbolCache {
        return this.systemCache;
    }

    setCache(uri: string, cache: FileSymbolCache): void {
        if (this.fileCaches.has(uri)) {
            this.fileCaches.delete(uri);
        }
        this.fileCaches.set(uri, cache);
        this.evictLeastRecentlyUsedCaches();
    }

    getCache(uri: string): FileSymbolCache | undefined {
        const cache = this.fileCaches.get(uri);
        if (!cache) {
            return undefined;
        }

        this.fileCaches.delete(uri);
        this.fileCaches.set(uri, cache);
        return cache;
    }

    private evictLeastRecentlyUsedCaches(): void {
        while (this.fileCaches.size > this.maxFileCaches) {
            const oldestUri = this.fileCaches.keys().next().value as string | undefined;
            if (!oldestUri) {
                return;
            }
            this.fileCaches.delete(oldestUri);
        }
    }

    deleteCache(uri: string): void {
        this.fileCaches.delete(uri);
    }

    deleteCachesInDirectory(directoryPath: string): void {
        const normalizedDirectory = URI.file(directoryPath).fsPath;
        for (const uri of this.fileCaches.keys()) {
            if (!uri.startsWith('file://')) {
                continue;
            }

            const fsPath = URI.parse(uri).fsPath;
            if (fsPath === normalizedDirectory || fsPath.startsWith(`${normalizedDirectory}${fsPath.includes('\\') ? '\\' : '/'}`)) {
                this.fileCaches.delete(uri);
            }
        }
    }

    getAllCaches(): FileSymbolCache[] {
        return Array.from(this.fileCaches.values());
    }

    private isUriLoadable(uri: string): boolean {
        if (this.getCache(uri)) {
            return true;
        }

        if (!uri.startsWith('file://')) {
            return false;
        }

        return existsSync(URI.parse(uri).fsPath);
    }

    getAvailableDependencies(uri: string): Dependency[] {
        const cache = this.getCache(uri);
        if (!cache) {
            return [];
        }

        return cache.dependencies.filter(dep => this.isUriLoadable(dep.uri));
    }

    findEntryFile(targetUri: string): string | undefined {
        const allCaches = this.getAllCaches();
        const incomingDependencies = new Set<string>();

        for (const cache of allCaches) {
            for (const dependency of this.getAvailableDependencies(cache.uri)) {
                incomingDependencies.add(dependency.uri);
            }
        }

        const canReachTarget = (startUri: string, visited: Set<string>): boolean => {
            if (startUri === targetUri) {
                return true;
            }
            if (visited.has(startUri)) {
                return false;
            }
            visited.add(startUri);

            const cache = this.getCache(startUri);
            if (!cache) {
                return false;
            }

            for (const dependency of this.getAvailableDependencies(cache.uri)) {
                if (canReachTarget(dependency.uri, visited)) {
                    return true;
                }
            }

            return false;
        };

        const rootCandidates = allCaches
            .map(cache => cache.uri)
            .filter(uri => !incomingDependencies.has(uri));

        for (const rootUri of rootCandidates) {
            if (canReachTarget(rootUri, new Set<string>())) {
                return rootUri;
            }
        }

        for (const cache of allCaches) {
            if (canReachTarget(cache.uri, new Set<string>())) {
                return cache.uri;
            }
        }

        return undefined;
    }

    *getAllSystemSymbols(kind: SymbolKind): IterableIterator<string> {
        const getNames = function* (map: Map<string, Symbol[]>) {
            for (const symbols of map.values()) {
                if (symbols.length > 0) {
                    yield symbols[0].name;
                }
            }
        };

        switch (kind) {
            case SymbolKind.BuiltinCommand:
                yield* getNames(this.systemCache.commands);
                break;
            case SymbolKind.BuiltinVariable:
                yield* getNames(this.systemCache.variables);
                break;
            case SymbolKind.Module:
                yield* getNames(this.systemCache.modules);
                break;
            case SymbolKind.Policy:
                yield* getNames(this.systemCache.policies);
                break;
            case SymbolKind.Property:
                yield* getNames(this.systemCache.properties);
                break;
        }
    }

    *getAllBuiltinCommands(): IterableIterator<string> {
        const emitted = new Set<string>();

        for (const command of this.getAllSystemSymbols(SymbolKind.BuiltinCommand)) {
            const key = command.toLowerCase();
            if (emitted.has(key)) {
                continue;
            }
            emitted.add(key);
            yield command;
        }

        for (const cache of this.fileCaches.values()) {
            if (!this.isBuiltinModuleUri(cache.uri)) {
                continue;
            }

            for (const symbols of cache.commands.values()) {
                for (const symbol of symbols) {
                    if (symbol.kind !== SymbolKind.Function && symbol.kind !== SymbolKind.Macro) {
                        continue;
                    }

                    const key = symbol.name.toLowerCase();
                    if (emitted.has(key)) {
                        continue;
                    }

                    emitted.add(key);
                    yield symbol.name;
                }
            }
        }

        for (const [key, command] of this.builtinModuleCommandCatalog) {
            if (emitted.has(key)) {
                continue;
            }

            emitted.add(key);
            yield command;
        }
    }

    hasBuiltinCommand(name: string): boolean {
        const key = name.toLowerCase();
        if (this.systemCache.commands.has(key)) {
            return true;
        }

        for (const cache of this.fileCaches.values()) {
            if (!this.isBuiltinModuleUri(cache.uri)) {
                continue;
            }

            const symbols = cache.commands.get(key);
            if (!symbols) {
                continue;
            }

            if (symbols.some(symbol => symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Macro)) {
                return true;
            }
        }

        if (this.builtinModuleCommandCatalog.has(key)) {
            return true;
        }

        return false;
    }

    *getAllUserCommandSymbols(): IterableIterator<string> {
        const emitted = new Set<string>();

        for (const cache of this.fileCaches.values()) {
            if (this.isBuiltinModuleUri(cache.uri)) {
                continue;
            }

            for (const symbols of cache.commands.values()) {
                for (const symbol of symbols) {
                    if (symbol.kind !== SymbolKind.Function && symbol.kind !== SymbolKind.Macro) {
                        continue;
                    }

                    const key = symbol.name.toLowerCase();
                    if (emitted.has(key)) {
                        continue;
                    }

                    emitted.add(key);
                    yield symbol.name;
                }
            }
        }
    }

    *getAllWorkspaceSymbols(kind: SymbolKind): IterableIterator<string> {
        const emitted = new Set<string>();

        for (const cache of this.fileCaches.values()) {
            switch (kind) {
                case SymbolKind.Function:
                case SymbolKind.Macro:
                    for (const symbols of cache.commands.values()) {
                        for (const symbol of symbols) {
                            if (symbol.kind !== kind) {
                                continue;
                            }
                            const key = symbol.name.toLowerCase();
                            if (emitted.has(key)) {
                                continue;
                            }
                            emitted.add(key);
                            yield symbol.name;
                        }
                    }
                    break;
                case SymbolKind.Variable:
                    for (const symbols of cache.variables.values()) {
                        for (const symbol of symbols) {
                            if (emitted.has(symbol.name)) {
                                continue;
                            }
                            emitted.add(symbol.name);
                            yield symbol.name;
                        }
                    }
                    break;
                case SymbolKind.Target:
                    for (const symbols of cache.targets.values()) {
                        for (const symbol of symbols) {
                            if (emitted.has(symbol.name)) {
                                continue;
                            }
                            emitted.add(symbol.name);
                            yield symbol.name;
                        }
                    }
                    break;
            }
        }
    }

    clear(): void {
        this.fileCaches.clear();
        this.builtinModuleCommandCatalog.clear();
    }

    public getReachableFiles(startUri: string): string[] {
        const ordered: string[] = [];
        const visited = new Set<string>();

        const visit = (uri: string) => {
            if (visited.has(uri)) {
                return;
            }
            visited.add(uri);
            ordered.push(uri);

            const cache = this.getCache(uri);
            if (!cache) {
                return;
            }

            for (const dep of this.getAvailableDependencies(cache.uri)) {
                visit(dep.uri);
            }
        };

        visit(startUri);
        return ordered;
    }

    /**
     * Returns the array of file URIs whose variables are visible from the targetUri
     * precisely simulating CMake's dynamic scoping (include vs add_subdirectory).
     */
    public getVisibleFilesForVariable(startUri: string, targetUri: string): string[] {
        const visited = new Set<string>();
        const stack: Array<{ uri: string; visibleFiles: string[]; depth: number }> = [{ uri: startUri, visibleFiles: [], depth: 0 }];

        while (stack.length > 0) {
            const current = stack.pop()!;
            if (current.depth > MAX_VISIBLE_FILES_DEPTH || visited.has(current.uri)) {
                continue;
            }
            visited.add(current.uri);

            const visibleFiles = [...current.visibleFiles, current.uri];
            if (current.uri === targetUri) {
                return this.collectVisibleIncludes(targetUri, visibleFiles);
            }

            const cache = this.getCache(current.uri);
            if (!cache) {
                continue;
            }

            const dependencies = this.getAvailableDependencies(cache.uri);
            for (let index = dependencies.length - 1; index >= 0; index--) {
                const dependency = dependencies[index];
                stack.push({
                    uri: dependency.uri,
                    visibleFiles: dependency.type === 'include' ? visibleFiles : [...visibleFiles],
                    depth: current.depth + 1,
                });
            }
        }

        return [];
    }

    private collectVisibleIncludes(targetUri: string, visibleFiles: string[]): string[] {
        const result = [...visibleFiles];
        const seen = new Set(result);
        const stack: Array<{ uri: string; depth: number }> = [{ uri: targetUri, depth: 0 }];

        while (stack.length > 0) {
            const current = stack.pop()!;
            if (current.depth >= MAX_VISIBLE_FILES_DEPTH) {
                continue;
            }

            const cache = this.getCache(current.uri);
            if (!cache) {
                continue;
            }

            for (const dependency of this.getAvailableDependencies(cache.uri)) {
                if (dependency.type !== 'include' || seen.has(dependency.uri)) {
                    continue;
                }
                seen.add(dependency.uri);
                result.push(dependency.uri);
                stack.push({ uri: dependency.uri, depth: current.depth + 1 });
            }
        }

        return result;
    }
}
