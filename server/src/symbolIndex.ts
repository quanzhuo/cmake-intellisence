import { existsSync } from 'fs';
import { Location, Range } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

function pathSeparatorFor(fsPath: string): '\\' | '/' {
    return fsPath.includes('\\') ? '\\' : '/';
}

const DEFAULT_MAX_FILE_CACHES = Number.POSITIVE_INFINITY;

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

export type SymbolNamespace = 'command' | 'variable' | 'cache-variable' | 'environment-variable' | 'target';
export type SymbolOccurrenceRole = 'declaration' | 'reference' | 'write';
export type SymbolWriteKind = 'assign' | 'unset';
export type SemanticScopeKind = 'file' | 'function' | 'macro' | 'foreach' | 'block';

export interface SemanticScope {
    id: string;
    kind: SemanticScopeKind;
    parentId?: string;
    startOrder: number;
    endOrder: number;
}

export interface SymbolOccurrence {
    name: string;
    canonicalName: string;
    namespace: SymbolNamespace;
    role: SymbolOccurrenceRole;
    uri: string;
    range: Range;
    scopeId: string;
    order: number;
    symbolId?: string;
    safeForRename: boolean;
    writeKind?: SymbolWriteKind;
}

export class Symbol {
    constructor(
        public name: string,
        public kind: SymbolKind,
        public uri: string,
        public line: number,
        public column: number,
        public scopeId: string = `${uri}#file`,
        public order: number = line,
        private readonly semanticId?: string,
    ) { }

    get id(): string {
        return this.semanticId ?? `${this.uri}#${this.kind}:${this.line}:${this.column}:${this.name}`;
    }

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
    order?: number;
    uncertain?: boolean;
}

export interface SetFileCacheOptions {
    preserveDependencyContexts?: boolean;
}

export interface DeleteFileCacheOptions {
    retainDependencyContexts?: boolean;
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
    public readonly dependencyInputVariables: Set<string> = new Set();
    public readonly variableValueReferences: Map<string, Set<string>> = new Map();
    public readonly occurrences: SymbolOccurrence[] = [];
    public readonly scopes: Map<string, SemanticScope> = new Map();
    public readonly uncertainOrders: Set<number> = new Set();
    public readonly conditionalOrders: Set<number> = new Set();
    private readonly occurrencesByName = new Map<string, SymbolOccurrence[]>();
    private readonly occurrencesByOrder = new Map<number, SymbolOccurrence[]>();
    private readonly unsafeRenameNames = new Map<SymbolNamespace, Set<string>>();

    constructor(public uri: string) {
        this.scopes.set(`${uri}#file`, {
            id: `${uri}#file`,
            kind: 'file',
            startOrder: 0,
            endOrder: Number.MAX_SAFE_INTEGER,
        });
    }

    addScope(scope: SemanticScope): void {
        this.scopes.set(scope.id, scope);
    }

    addOccurrence(occurrence: SymbolOccurrence): void {
        this.occurrences.push(occurrence);
        const key = `${occurrence.namespace}\0${occurrence.canonicalName}`;
        const indexedOccurrences = this.occurrencesByName.get(key) ?? [];
        indexedOccurrences.push(occurrence);
        this.occurrencesByName.set(key, indexedOccurrences);
        const orderedOccurrences = this.occurrencesByOrder.get(occurrence.order) ?? [];
        orderedOccurrences.push(occurrence);
        this.occurrencesByOrder.set(occurrence.order, orderedOccurrences);
    }

    getOccurrences(namespace: SymbolNamespace, canonicalName: string): readonly SymbolOccurrence[] {
        return this.occurrencesByName.get(`${namespace}\0${canonicalName}`) ?? [];
    }

    getOccurrencesAtOrder(order: number): readonly SymbolOccurrence[] {
        return this.occurrencesByOrder.get(order) ?? [];
    }

    markOrderUncertain(order: number): void {
        this.uncertainOrders.add(order);
    }

    markOrderConditional(order: number): void {
        this.conditionalOrders.add(order);
    }

    markRenameUnsafe(namespace: SymbolNamespace, canonicalName?: string): void {
        const names = this.unsafeRenameNames.get(namespace) ?? new Set<string>();
        names.add(canonicalName ?? '*');
        this.unsafeRenameNames.set(namespace, names);
    }

    isRenameSafe(namespace: SymbolNamespace, canonicalName: string): boolean {
        const names = this.unsafeRenameNames.get(namespace);
        return !names?.has('*') && !names?.has(canonicalName);
    }

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

    addDependency(uri: string, type: DependencyType, order?: number, uncertain?: boolean) {
        this.dependencies.push({
            uri,
            type,
            ...(order === undefined ? {} : { order }),
            ...(uncertain ? { uncertain: true } : {}),
        });
    }

    addDependencyInputVariable(variableName: string): void {
        this.dependencyInputVariables.add(variableName);
    }

    addVariableValueReference(variableName: string, referencedVariable: string): void {
        const references = this.variableValueReferences.get(variableName) ?? new Set<string>();
        references.add(referencedVariable);
        this.variableValueReferences.set(variableName, references);
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
    private fileCacheRevisionKeys: Map<string, string> = new Map();
    private dependencyContexts = new Map<string, Map<string, { revisionKey?: string; dependencies: Dependency[] }>>();
    private retainedDependencyContexts = new Map<string, Map<string, Dependency[]>>();
    private systemCache: FileSymbolCache = new FileSymbolCache('cmake-builtin://system');
    private builtinModuleCommandCatalog: Map<string, string> = new Map();
    private generation = 0;
    private readonly entryFileCache = new Map<string, { generation: number; value: string | undefined }>();
    private readonly reachableFilesCache = new Map<string, { generation: number; value: string[] }>();
    private readonly visibleFilesCache = new Map<string, { generation: number; value: string[] }>();
    private readonly workspaceSymbolNamesCache = new Map<SymbolKind, { generation: number; value: string[] }>();
    private userCommandNamesCache?: { generation: number; value: string[] };

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

    isBuiltinModuleUri(uri: string): boolean {
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

    private invalidateDerivedCaches(): void {
        this.generation++;
        this.entryFileCache.clear();
        this.reachableFilesCache.clear();
        this.visibleFilesCache.clear();
        this.workspaceSymbolNamesCache.clear();
        this.userCommandNamesCache = undefined;
    }

    setCache(
        uri: string,
        cache: FileSymbolCache,
        revisionKey?: string,
        entryFile?: string,
        options?: SetFileCacheOptions,
    ): void {
        if (this.fileCaches.has(uri)) {
            this.fileCaches.delete(uri);
        }
        this.fileCaches.set(uri, cache);
        if (revisionKey === undefined) {
            this.fileCacheRevisionKeys.delete(uri);
        } else {
            this.fileCacheRevisionKeys.set(uri, revisionKey);
        }
        if (options?.preserveDependencyContexts) {
            const retainedContexts = this.retainedDependencyContexts.get(uri);
            for (const [retainedEntry, dependencies] of retainedContexts ?? []) {
                const contextsByUri = this.dependencyContexts.get(retainedEntry) ?? new Map();
                contextsByUri.set(uri, {
                    revisionKey,
                    dependencies: dependencies.map(dependency => ({ ...dependency })),
                });
                this.dependencyContexts.set(retainedEntry, contextsByUri);
            }
        }
        this.retainedDependencyContexts.delete(uri);
        for (const contextsByUri of this.dependencyContexts.values()) {
            const context = contextsByUri.get(uri);
            if (context && context.revisionKey !== revisionKey) {
                if (options?.preserveDependencyContexts) {
                    context.revisionKey = revisionKey;
                } else {
                    contextsByUri.delete(uri);
                }
            }
        }
        if (entryFile !== undefined) {
            const contextsByUri = this.dependencyContexts.get(entryFile) ?? new Map();
            const preservedContext = options?.preserveDependencyContexts
                ? contextsByUri.get(uri)
                : undefined;
            if (preservedContext) {
                preservedContext.revisionKey = revisionKey;
            } else {
                contextsByUri.set(uri, {
                    revisionKey,
                    dependencies: cache.dependencies.map(dependency => ({ ...dependency })),
                });
            }
            this.dependencyContexts.set(entryFile, contextsByUri);
        }
        this.invalidateDerivedCaches();
        this.evictLeastRecentlyUsedCaches();
    }

    hasCurrentCache(uri: string, revisionKey: string, entryFile?: string): boolean {
        if (!this.fileCaches.has(uri) || this.fileCacheRevisionKeys.get(uri) !== revisionKey) {
            return false;
        }
        return entryFile === undefined
            || this.dependencyContexts.get(entryFile)?.get(uri)?.revisionKey === revisionKey;
    }

    getCacheRevisionKey(uri: string): string | undefined {
        return this.fileCacheRevisionKeys.get(uri);
    }

    hasDependencyContext(uri: string, entryFile: string): boolean {
        return this.dependencyContexts.get(entryFile)?.has(uri) ?? false;
    }

    clearProjectContexts(): void {
        if (this.dependencyContexts.size === 0) {
            return;
        }
        this.dependencyContexts.clear();
        this.invalidateDerivedCaches();
    }

    clearProjectContext(entryFile: string): void {
        if (!this.dependencyContexts.delete(entryFile)) {
            return;
        }
        this.invalidateDerivedCaches();
    }

    getProjectEntries(): string[] {
        return Array.from(this.dependencyContexts.keys());
    }

    getProjectEntriesForUri(uri: string): string[] {
        const entries: string[] = [];
        for (const [entryFile, contextsByUri] of this.dependencyContexts) {
            if (entryFile === uri || contextsByUri.has(uri)) {
                entries.push(entryFile);
            }
        }
        return entries;
    }

    getProjectDependencyInputVariables(entryFile: string): Set<string> {
        const inputs = new Set<string>();
        const referencesByVariable = new Map<string, Set<string>>();
        for (const uri of this.getReachableFiles(entryFile)) {
            const cache = this.getCache(uri);
            if (!cache) {
                continue;
            }
            for (const variableName of cache.dependencyInputVariables) {
                inputs.add(variableName);
            }
            for (const [variableName, references] of cache.variableValueReferences) {
                const combinedReferences = referencesByVariable.get(variableName) ?? new Set<string>();
                for (const referencedVariable of references) {
                    combinedReferences.add(referencedVariable);
                }
                referencesByVariable.set(variableName, combinedReferences);
            }
        }

        const pending = Array.from(inputs);
        for (let index = 0; index < pending.length; index++) {
            const variableName = pending[index];
            for (const referencedVariable of referencesByVariable.get(variableName) ?? []) {
                if (!inputs.has(referencedVariable)) {
                    inputs.add(referencedVariable);
                    pending.push(referencedVariable);
                }
            }
        }
        return inputs;
    }

    getGeneration(): number {
        return this.generation;
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
            this.fileCacheRevisionKeys.delete(oldestUri);
            this.deleteDependencyContextsForUri(oldestUri);
        }
    }

    deleteCache(uri: string, options?: DeleteFileCacheOptions): void {
        const deleted = this.fileCaches.delete(uri);
        this.fileCacheRevisionKeys.delete(uri);
        if (options?.retainDependencyContexts) {
            const retainedContexts = this.retainedDependencyContexts.get(uri) ?? new Map<string, Dependency[]>();
            for (const [entryFile, contextsByUri] of this.dependencyContexts) {
                const context = contextsByUri.get(uri);
                if (context) {
                    retainedContexts.set(
                        entryFile,
                        context.dependencies.map(dependency => ({ ...dependency })),
                    );
                }
            }
            if (retainedContexts.size > 0) {
                this.retainedDependencyContexts.set(uri, retainedContexts);
            }
        } else {
            this.retainedDependencyContexts.delete(uri);
        }
        this.deleteDependencyContextsForUri(uri);
        if (deleted) {
            this.invalidateDerivedCaches();
        }
    }

    deleteCachesInDirectory(directoryPath: string): void {
        const normalizedDirectory = URI.file(directoryPath).fsPath;
        const isInsideDirectory = (uri: string): boolean => {
            if (!uri.startsWith('file://')) {
                return false;
            }
            const fsPath = URI.parse(uri).fsPath;
            return fsPath === normalizedDirectory
                || fsPath.startsWith(`${normalizedDirectory}${fsPath.includes('\\') ? '\\' : '/'}`);
        };
        let deleted = false;
        for (const uri of this.fileCaches.keys()) {
            if (!isInsideDirectory(uri)) {
                continue;
            }

            this.fileCaches.delete(uri);
            this.fileCacheRevisionKeys.delete(uri);
            this.retainedDependencyContexts.delete(uri);
            this.deleteDependencyContextsForUri(uri);
            deleted = true;
        }
        for (const uri of this.retainedDependencyContexts.keys()) {
            if (isInsideDirectory(uri)) {
                this.retainedDependencyContexts.delete(uri);
            }
        }
        if (deleted) {
            this.invalidateDerivedCaches();
        }
    }

    getAllCaches(): FileSymbolCache[] {
        return Array.from(this.fileCaches.values());
    }

    private deleteDependencyContextsForUri(uri: string): void {
        for (const [entryFile, contextsByUri] of this.dependencyContexts) {
            contextsByUri.delete(uri);
            if (contextsByUri.size === 0) {
                this.dependencyContexts.delete(entryFile);
            }
        }
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

    getAvailableDependencies(
        uri: string,
        entryFile?: string,
        cacheOverrides?: ReadonlyMap<string, FileSymbolCache>,
    ): Dependency[] {
        const override = cacheOverrides?.get(uri);
        const cache = override ?? this.getCache(uri);
        if (!cache) {
            return [];
        }

        const contextualDependencies = override || entryFile === undefined
            ? undefined
            : this.dependencyContexts.get(entryFile)?.get(uri)?.dependencies;
        const dependencies = contextualDependencies
            ?? (override || entryFile === undefined || this.fileCacheRevisionKeys.get(uri) === undefined
                ? cache.dependencies
                : []);
        return dependencies.filter(dep => this.isUriLoadable(dep.uri));
    }

    findEntryFile(targetUri: string): string | undefined {
        const cached = this.entryFileCache.get(targetUri);
        if (cached?.generation === this.generation) {
            return cached.value;
        }

        for (const entryFile of this.dependencyContexts.keys()) {
            if (entryFile === targetUri) {
                continue;
            }
            if (this.getReachableFiles(entryFile).includes(targetUri)) {
                this.entryFileCache.set(targetUri, { generation: this.generation, value: entryFile });
                return entryFile;
            }
        }

        if (this.dependencyContexts.get(targetUri)?.has(targetUri)) {
            this.entryFileCache.set(targetUri, { generation: this.generation, value: targetUri });
            return targetUri;
        }

        const contextFreeEntry = this.findContextFreeEntryFile(targetUri);
        if (contextFreeEntry) {
            this.entryFileCache.set(targetUri, { generation: this.generation, value: contextFreeEntry });
            return contextFreeEntry;
        }

        if (this.fileCaches.has(targetUri)) {
            this.entryFileCache.set(targetUri, { generation: this.generation, value: targetUri });
            return targetUri;
        }

        this.entryFileCache.set(targetUri, { generation: this.generation, value: undefined });
        return undefined;
    }

    private findContextFreeEntryFile(targetUri: string): string | undefined {
        if (this.fileCacheRevisionKeys.get(targetUri) !== undefined) {
            return undefined;
        }

        const parentsByUri = new Map<string, string[]>();
        for (const [uri, cache] of this.fileCaches) {
            if (this.fileCacheRevisionKeys.get(uri) !== undefined) {
                continue;
            }
            for (const dependency of cache.dependencies) {
                if (this.fileCacheRevisionKeys.get(dependency.uri) !== undefined) {
                    continue;
                }
                const parents = parentsByUri.get(dependency.uri) ?? [];
                parents.push(uri);
                parentsByUri.set(dependency.uri, parents);
            }
        }

        const ancestors = new Set<string>([targetUri]);
        const pending = [targetUri];
        for (let index = 0; index < pending.length; index++) {
            for (const parent of parentsByUri.get(pending[index]) ?? []) {
                if (!ancestors.has(parent)) {
                    ancestors.add(parent);
                    pending.push(parent);
                }
            }
        }

        for (const uri of ancestors) {
            if ((parentsByUri.get(uri) ?? []).every(parent => !ancestors.has(parent))) {
                return uri;
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

    hasCoreBuiltinCommand(name: string): boolean {
        return this.systemCache.commands.has(name.toLowerCase());
    }

    *getAllUserCommandSymbols(): IterableIterator<string> {
        if (this.userCommandNamesCache?.generation === this.generation) {
            yield* this.userCommandNamesCache.value;
            return;
        }

        const emitted = new Set<string>();
        const names: string[] = [];

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
                    names.push(symbol.name);
                }
            }
        }
        this.userCommandNamesCache = { generation: this.generation, value: names };
        yield* names;
    }

    *getAllWorkspaceSymbols(kind: SymbolKind): IterableIterator<string> {
        const cached = this.workspaceSymbolNamesCache.get(kind);
        if (cached?.generation === this.generation) {
            yield* cached.value;
            return;
        }

        const emitted = new Set<string>();
        const names: string[] = [];

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
                            names.push(symbol.name);
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
                            names.push(symbol.name);
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
                            names.push(symbol.name);
                        }
                    }
                    break;
            }
        }
        this.workspaceSymbolNamesCache.set(kind, { generation: this.generation, value: names });
        yield* names;
    }

    clear(): void {
        this.fileCaches.clear();
        this.fileCacheRevisionKeys.clear();
        this.dependencyContexts.clear();
        this.retainedDependencyContexts.clear();
        this.builtinModuleCommandCatalog.clear();
        this.invalidateDerivedCaches();
    }

    public getReachableFiles(startUri: string, cacheOverrides?: ReadonlyMap<string, FileSymbolCache>): string[] {
        const cached = cacheOverrides?.size ? undefined : this.reachableFilesCache.get(startUri);
        if (cached?.generation === this.generation) {
            return [...cached.value];
        }

        const ordered: string[] = [];
        const visited = new Set<string>();

        const stack = [startUri];
        while (stack.length > 0) {
            const uri = stack.pop()!;
            if (visited.has(uri)) {
                continue;
            }
            visited.add(uri);
            ordered.push(uri);

            const dependencies = this.getAvailableDependencies(uri, startUri, cacheOverrides);
            for (let index = dependencies.length - 1; index >= 0; index--) {
                stack.push(dependencies[index].uri);
            }
        }
        if (!cacheOverrides?.size) {
            this.reachableFilesCache.set(startUri, { generation: this.generation, value: ordered });
        }
        return [...ordered];
    }

    /**
     * Returns the array of file URIs whose variables are visible from the targetUri
     * precisely simulating CMake's dynamic scoping (include vs add_subdirectory).
     */
    public getVisibleFilesForVariable(
        startUri: string,
        targetUri: string,
        cacheOverrides?: ReadonlyMap<string, FileSymbolCache>,
    ): string[] {
        const cacheKey = `${startUri}\0${targetUri}`;
        const cached = cacheOverrides?.size ? undefined : this.visibleFilesCache.get(cacheKey);
        if (cached?.generation === this.generation) {
            return [...cached.value];
        }

        const visited = new Set<string>();
        const stack: Array<{ uri: string; visibleFiles: string[] }> = [{ uri: startUri, visibleFiles: [] }];

        while (stack.length > 0) {
            const current = stack.pop()!;
            if (visited.has(current.uri)) {
                continue;
            }
            visited.add(current.uri);

            const visibleFiles = [...current.visibleFiles, current.uri];
            if (current.uri === targetUri) {
                const result = this.collectVisibleIncludes(startUri, targetUri, visibleFiles, cacheOverrides);
                if (!cacheOverrides?.size) {
                    this.visibleFilesCache.set(cacheKey, { generation: this.generation, value: result });
                }
                return [...result];
            }

            const cache = cacheOverrides?.get(current.uri) ?? this.getCache(current.uri);
            if (!cache) {
                continue;
            }

            const dependencies = this.getAvailableDependencies(cache.uri, startUri, cacheOverrides);
            for (let index = dependencies.length - 1; index >= 0; index--) {
                const dependency = dependencies[index];
                stack.push({
                    uri: dependency.uri,
                    visibleFiles,
                });
            }
        }

        if (!cacheOverrides?.size) {
            this.visibleFilesCache.set(cacheKey, { generation: this.generation, value: [] });
        }
        return [];
    }

    private collectVisibleIncludes(
        startUri: string,
        targetUri: string,
        visibleFiles: string[],
        cacheOverrides?: ReadonlyMap<string, FileSymbolCache>,
    ): string[] {
        const result = [...visibleFiles];
        const seen = new Set(result);
        const stack: string[] = [targetUri];

        while (stack.length > 0) {
            const currentUri = stack.pop()!;
            const cache = cacheOverrides?.get(currentUri) ?? this.getCache(currentUri);
            if (!cache) {
                continue;
            }

            for (const dependency of this.getAvailableDependencies(cache.uri, startUri, cacheOverrides)) {
                if (dependency.type !== 'include' || seen.has(dependency.uri)) {
                    continue;
                }
                seen.add(dependency.uri);
                result.push(dependency.uri);
                stack.push(dependency.uri);
            }
        }

        return result;
    }
}
