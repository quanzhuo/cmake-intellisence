import { existsSync } from 'fs';
import { Location } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

function pathSeparatorFor(fsPath: string): '\\' | '/' {
    return fsPath.includes('\\') ? '\\' : '/';
}

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
    public cmakeVersion: string = '';
    public cmakeModulePath: string | undefined;
    public pkgConfigPath: string = '';
    public pkgConfigModules: Map<string, string> = new Map();
    private fileCaches: Map<string, FileSymbolCache> = new Map();
    private systemCache: FileSymbolCache = new FileSymbolCache('cmake-builtin://system');
    private builtinModuleCommandCatalog: Map<string, string> = new Map();

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
        this.fileCaches.set(uri, cache);
    }

    getCache(uri: string): FileSymbolCache | undefined {
        return this.fileCaches.get(uri);
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
        let resultPath: string[] | null = null;
        const visited = new Set<string>();

        const simulateExecution = (currentUri: string, visibleFiles: string[]): boolean => {
            if (visited.has(currentUri)) {
                return false;
            }
            visited.add(currentUri);

            visibleFiles.push(currentUri);

            if (currentUri === targetUri) {
                const targetCache = this.getCache(currentUri);
                if (targetCache) {
                    const gatherIncludes = (u: string) => {
                        const c = this.getCache(u);
                        if (!c) { return; }
                        for (const dep of this.getAvailableDependencies(c.uri)) {
                            if (dep.type === "include" && !visited.has(dep.uri)) {
                                visited.add(dep.uri);
                                visibleFiles.push(dep.uri);
                                gatherIncludes(dep.uri);
                            }
                        }
                    };
                    gatherIncludes(currentUri);
                }

                resultPath = [...visibleFiles];
                return true;
            }

            const cache = this.getCache(currentUri);
            if (!cache) { return false; }

            for (const dep of this.getAvailableDependencies(cache.uri)) {
                if (dep.type === "include") {
                    if (simulateExecution(dep.uri, visibleFiles)) {
                        return true;
                    }
                } else {
                    const childScope = [...visibleFiles];
                    if (simulateExecution(dep.uri, childScope)) {
                        return true;
                    }
                }
            }

            return false;
        };

        simulateExecution(startUri, []);
        return resultPath || [];
    }
}
