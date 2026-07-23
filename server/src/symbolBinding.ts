import { Location, Position, Range } from 'vscode-languageserver';
import { Dependency, FileSymbolCache, SymbolIndex, SymbolNamespace, SymbolOccurrence } from './symbolIndex';

export interface DefinitionBinding {
    declarations: SymbolOccurrence[];
    symbolIds: string[];
    usedWorkspaceFallback: boolean;
}

export interface ReferenceBinding {
    locations: Location[];
    complete: boolean;
    safeForRename: boolean;
    symbolId?: string;
}

function comparePositions(left: Position, right: Position): number {
    return left.line === right.line
        ? left.character - right.character
        : left.line - right.line;
}

function rangeContains(range: Range, position: Position): boolean {
    return comparePositions(range.start, position) <= 0
        && comparePositions(position, range.end) < 0;
}

function rangeWeight(range: Range): number {
    return (range.end.line - range.start.line) * 1_000_000
        + Math.max(range.end.character - range.start.character, 0);
}

function occurrenceKey(occurrence: SymbolOccurrence): string {
    const { start, end } = occurrence.range;
    return `${occurrence.namespace}\0${occurrence.role}\0${occurrence.uri}\0${start.line}:${start.character}:${end.line}:${end.character}`;
}

function uniqueOccurrences(occurrences: SymbolOccurrence[]): SymbolOccurrence[] {
    const result: SymbolOccurrence[] = [];
    const seen = new Set<string>();
    for (const occurrence of occurrences) {
        const key = occurrenceKey(occurrence);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(occurrence);
        }
    }
    return result;
}

export class SymbolBindingResolver {
    private projectDirectoryScopes?: Map<string, string>;
    private executionOrder?: Map<string, number>;
    private uncertainExecutionOccurrences?: Set<string>;
    private repeatedExecutionOccurrences?: Set<string>;
    private projectFiles?: string[];
    private readonly projectDeclarations = new Map<string, SymbolOccurrence[]>();
    private readonly projectOccurrences = new Map<string, SymbolOccurrence[]>();
    private readonly workspaceDeclarations = new Map<string, SymbolOccurrence[]>();

    constructor(
        private readonly symbolIndex: SymbolIndex,
        private readonly entryFile: string,
        private readonly currentFile: string,
        private readonly cacheOverrides: ReadonlyMap<string, FileSymbolCache> = new Map(),
    ) { }

    private getCache(uri: string): FileSymbolCache | undefined {
        return this.cacheOverrides.get(uri) ?? this.symbolIndex.getCache(uri);
    }

    private getAvailableDependencies(uri: string): readonly Dependency[] {
        return this.symbolIndex.getAvailableDependencies(uri, this.entryFile, this.cacheOverrides);
    }

    findOccurrenceAt(position: Position, namespace?: SymbolNamespace): SymbolOccurrence | null {
        const cache = this.getCache(this.currentFile);
        if (!cache) {
            return null;
        }

        const candidates = cache.occurrences
            .filter(occurrence => (!namespace || occurrence.namespace === namespace) && rangeContains(occurrence.range, position))
            .sort((left, right) => {
                if (left.role === 'declaration' && right.role !== 'declaration') {
                    return -1;
                }
                if (right.role === 'declaration' && left.role !== 'declaration') {
                    return 1;
                }
                return rangeWeight(left.range) - rangeWeight(right.range);
            });
        return candidates[0] ?? null;
    }

    resolveVariableAtLine(variableName: string, maxLine: number): DefinitionBinding {
        const cache = this.getCache(this.currentFile);
        if (!cache) {
            return { declarations: [], symbolIds: [], usedWorkspaceFallback: false };
        }

        const indexedReference = cache.getOccurrences('variable', variableName)
            .filter(occurrence => occurrence.role !== 'declaration' && occurrence.range.start.line <= maxLine)
            .sort((left, right) => right.range.start.line - left.range.start.line || right.order - left.order)[0];
        if (indexedReference) {
            return this.resolveVariableDefinitions(indexedReference);
        }

        const precedingOccurrences = cache.occurrences.filter(occurrence => occurrence.range.start.line <= maxLine);
        const order = precedingOccurrences.reduce((latest, occurrence) => Math.max(latest, occurrence.order), 0) + 0.5;
        const scope = Array.from(cache.scopes.values())
            .filter(candidate => candidate.startOrder <= order && order < candidate.endOrder)
            .sort((left, right) => right.startOrder - left.startOrder)[0];
        return this.resolveVariableDefinitions({
            name: variableName,
            canonicalName: variableName,
            namespace: 'variable',
            role: 'reference',
            uri: this.currentFile,
            range: Range.create(maxLine, 0, maxLine, 0),
            scopeId: scope?.id ?? `${this.currentFile}#file`,
            order,
            safeForRename: false,
        });
    }

    resolveDefinitions(occurrence: SymbolOccurrence, allowWorkspaceFallback = true): DefinitionBinding {
        if (occurrence.role === 'declaration' && occurrence.symbolId) {
            return {
                declarations: [occurrence],
                symbolIds: [this.getEffectiveSymbolId(occurrence)],
                usedWorkspaceFallback: false,
            };
        }

        if (occurrence.namespace === 'variable'
            || occurrence.namespace === 'cache-variable'
            || occurrence.namespace === 'environment-variable') {
            return this.resolveVariableDefinitions(occurrence);
        }

        const projectDeclarations = this.selectProjectDeclarations(occurrence);
        if (projectDeclarations.length > 0) {
            return {
                declarations: projectDeclarations,
                symbolIds: Array.from(new Set(projectDeclarations.map(declaration => this.getEffectiveSymbolId(declaration)))),
                usedWorkspaceFallback: false,
            };
        }

        if (!allowWorkspaceFallback || occurrence.namespace !== 'command') {
            return { declarations: [], symbolIds: [], usedWorkspaceFallback: false };
        }

        if (this.symbolIndex.hasBuiltinCommand(occurrence.canonicalName)) {
            return { declarations: [], symbolIds: [], usedWorkspaceFallback: false };
        }

        const workspaceDeclarations = this.getAllDeclarations(occurrence.namespace, occurrence.canonicalName);
        const symbolIds = Array.from(new Set(workspaceDeclarations.map(declaration => this.getEffectiveSymbolId(declaration))));
        return symbolIds.length === 1
            ? { declarations: workspaceDeclarations, symbolIds, usedWorkspaceFallback: true }
            : { declarations: [], symbolIds: [], usedWorkspaceFallback: false };
    }

    findReferences(occurrence: SymbolOccurrence, includeDeclaration: boolean): ReferenceBinding {
        const sourceBinding = this.resolveDefinitions(occurrence, false);
        if (sourceBinding.symbolIds.length !== 1) {
            return { locations: [], complete: false, safeForRename: false };
        }

        const symbolId = sourceBinding.symbolIds[0];
        const locations: Location[] = [];
        const candidateNamespaces: SymbolNamespace[] = symbolId.startsWith('cache-variable:')
            ? ['variable', 'cache-variable']
            : [occurrence.namespace];
        let complete = this.hasCompleteRenameCoverage(candidateNamespaces, occurrence.canonicalName);
        let safeForRename = complete;
        const candidateOccurrences = uniqueOccurrences(candidateNamespaces.flatMap(namespace =>
            this.getProjectOccurrences(namespace, occurrence.canonicalName)
        ));
        for (const candidate of candidateOccurrences) {
            if (candidate.role === 'declaration') {
                if (candidate.symbolId && this.getEffectiveSymbolId(candidate) === symbolId && includeDeclaration) {
                    locations.push(this.toLocation(candidate));
                }
                continue;
            }

            const binding = this.resolveDefinitions(candidate, false);
            if (binding.symbolIds.length !== 1) {
                complete = false;
                continue;
            }
            if (binding.symbolIds[0] !== symbolId) {
                continue;
            }

            locations.push(this.toLocation(candidate));
            safeForRename = safeForRename && candidate.safeForRename;
        }

        const deduplicated = new Map<string, Location>();
        for (const location of locations) {
            const key = `${location.uri}\0${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
            deduplicated.set(key, location);
        }

        return {
            locations: Array.from(deduplicated.values()),
            complete,
            safeForRename,
            symbolId,
        };
    }

    private resolveVariableDefinitions(occurrence: SymbolOccurrence): DefinitionBinding {
        type VariableCandidate = { occurrence: SymbolOccurrence; score: number; conditional: boolean };
        const collectCandidates = (namespace: SymbolNamespace): VariableCandidate[] => {
            const visibleFiles = namespace === 'cache-variable' || namespace === 'environment-variable'
                ? this.getProjectFiles()
                : this.symbolIndex.getVisibleFilesForVariable(this.entryFile, occurrence.uri, this.cacheOverrides);
            if (!visibleFiles.includes(occurrence.uri)) {
                visibleFiles.push(occurrence.uri);
            }

            const candidates: VariableCandidate[] = [];
            for (const [fileIndex, uri] of visibleFiles.entries()) {
                const cache = this.getCache(uri);
                if (!cache) {
                    continue;
                }

                for (const declaration of cache.getOccurrences(namespace, occurrence.canonicalName)) {
                    if (declaration.role !== 'declaration'
                        || !declaration.symbolId) {
                        continue;
                    }

                    if (uri === occurrence.uri && namespace === 'variable') {
                        if (declaration.order > occurrence.order
                            || (declaration.order === occurrence.order && occurrence.role !== 'declaration')
                            || !this.isScopeVisible(cache, declaration.scopeId, occurrence.scopeId)) {
                            continue;
                        }
                        const scopeDepth = this.getScopeDepth(cache, declaration.scopeId);
                        candidates.push({
                            occurrence: declaration,
                            score: 1_000_000 + scopeDepth * 10_000 + declaration.order,
                            conditional: cache.conditionalOrders.has(declaration.order),
                        });
                    } else {
                        const scope = cache.scopes.get(declaration.scopeId);
                        if (scope?.kind !== 'file' && namespace === 'variable') {
                            continue;
                        }
                        candidates.push({
                            occurrence: declaration,
                            score: fileIndex * 10_000 + declaration.order,
                            conditional: cache.conditionalOrders.has(declaration.order),
                        });
                    }
                }
            }

            return candidates;
        };

        const executionOrder = this.getExecutionOrder();
        const referenceExecutionOrder = executionOrder.get(occurrenceKey(occurrence));
        const referenceExecutionIsRepeated = this.repeatedExecutionOccurrences?.has(occurrenceKey(occurrence)) ?? false;
        const latestUnsetOrderByScope = new Map<string, number>();
        for (const namespace of ['variable', 'cache-variable', 'environment-variable'] as const) {
            for (const candidate of this.getProjectOccurrences(namespace, occurrence.canonicalName)) {
                if (candidate.role !== 'write' || candidate.writeKind !== 'unset') {
                    continue;
                }
                const candidateOrder = executionOrder.get(occurrenceKey(candidate));
                const candidateCache = this.getCache(candidate.uri);
                if (candidateOrder === undefined
                    || (referenceExecutionOrder !== undefined && candidateOrder > referenceExecutionOrder)
                    || candidateCache?.conditionalOrders.has(candidate.order)
                    || this.uncertainExecutionOccurrences?.has(occurrenceKey(candidate))) {
                    continue;
                }
                const scopeKey = this.getEffectiveVariableScopeKey(candidate);
                latestUnsetOrderByScope.set(
                    scopeKey,
                    Math.max(latestUnsetOrderByScope.get(scopeKey) ?? Number.NEGATIVE_INFINITY, candidateOrder),
                );
            }
        }
        const rankCandidates = (candidates: VariableCandidate[]): VariableCandidate[] => candidates.flatMap(candidate => {
            const cache = this.getCache(candidate.occurrence.uri);
            const scope = cache?.scopes.get(candidate.occurrence.scopeId);
            const isLexicalCandidate = candidate.occurrence.namespace === 'variable'
                && candidate.occurrence.uri === occurrence.uri
                && scope !== undefined
                && scope.kind !== 'file';
            const candidateExecutionOrder = executionOrder.get(occurrenceKey(candidate.occurrence));
            const latestUnsetOrder = latestUnsetOrderByScope.get(this.getEffectiveVariableScopeKey(candidate.occurrence));
            if (candidateExecutionOrder !== undefined
                && latestUnsetOrder !== undefined
                && candidateExecutionOrder <= latestUnsetOrder) {
                return [];
            }
            if (!isLexicalCandidate
                && referenceExecutionOrder !== undefined
                && candidateExecutionOrder !== undefined
                && candidateExecutionOrder > referenceExecutionOrder) {
                return [];
            }

            const priority = isLexicalCandidate
                ? Number.MAX_SAFE_INTEGER / 2 + this.getScopeDepth(cache!, candidate.occurrence.scopeId) * 10_000 + candidate.occurrence.order
                : candidateExecutionOrder ?? candidate.score;
            return [{
                ...candidate,
                score: priority,
                conditional: candidate.conditional
                    || (!isLexicalCandidate && (this.uncertainExecutionOccurrences?.has(occurrenceKey(candidate.occurrence)) ?? false)),
            }];
        });
        let rankedCandidates = rankCandidates(collectCandidates(occurrence.namespace));
        if (rankedCandidates.length === 0 && occurrence.namespace === 'variable') {
            rankedCandidates = rankCandidates(collectCandidates('cache-variable'));
        }
        if (rankedCandidates.length === 0) {
            return { declarations: [], symbolIds: [], usedWorkspaceFallback: false };
        }

        const certainCandidates = rankedCandidates.filter(candidate => !candidate.conditional);
        const conditionalCandidates = rankedCandidates.filter(candidate => candidate.conditional);
        const latestCertainScore = certainCandidates.length > 0
            ? Math.max(...certainCandidates.map(candidate => candidate.score))
            : Number.NEGATIVE_INFINITY;
        const latestConditionalScore = conditionalCandidates.length > 0
            ? Math.max(...conditionalCandidates.map(candidate => candidate.score))
            : Number.NEGATIVE_INFINITY;
        const bestCandidates = (referenceExecutionIsRepeated
            ? rankedCandidates
            : latestConditionalScore > latestCertainScore
                ? rankedCandidates.filter(candidate => candidate.score >= latestCertainScore)
                : certainCandidates.filter(candidate => candidate.score === latestCertainScore)
        ).map(candidate => candidate.occurrence);
        const symbolIds = Array.from(new Set(bestCandidates.map(candidate => this.getEffectiveSymbolId(candidate))));
        return {
            declarations: uniqueOccurrences(bestCandidates),
            symbolIds,
            usedWorkspaceFallback: false,
        };
    }

    private isScopeVisible(cache: FileSymbolCache, declarationScopeId: string, referenceScopeId: string): boolean {
        let currentScopeId: string | undefined = referenceScopeId;
        while (currentScopeId) {
            if (currentScopeId === declarationScopeId) {
                return true;
            }
            currentScopeId = cache.scopes.get(currentScopeId)?.parentId;
        }
        return false;
    }

    private getScopeDepth(cache: FileSymbolCache, scopeId: string): number {
        let depth = 0;
        let currentScopeId: string | undefined = scopeId;
        while (currentScopeId) {
            depth++;
            currentScopeId = cache.scopes.get(currentScopeId)?.parentId;
        }
        return depth;
    }

    private getProjectFiles(): string[] {
        if (this.projectFiles) {
            return this.projectFiles;
        }

        const files = this.symbolIndex.getReachableFiles(this.entryFile, this.cacheOverrides);
        if (!files.includes(this.currentFile)) {
            files.push(this.currentFile);
        }
        this.projectFiles = files;
        return this.projectFiles;
    }

    private getEffectiveSymbolId(occurrence: SymbolOccurrence): string {
        if (!occurrence.symbolId
            || (occurrence.namespace !== 'variable'
                && occurrence.namespace !== 'cache-variable'
                && occurrence.namespace !== 'environment-variable')) {
            return occurrence.symbolId ?? `${occurrence.namespace}:${occurrence.uri}:${occurrence.range.start.line}:${occurrence.range.start.character}`;
        }

        if (occurrence.namespace === 'cache-variable' || occurrence.namespace === 'environment-variable') {
            return `${occurrence.namespace}:${this.entryFile}:${occurrence.name}`;
        }

        const cache = this.getCache(occurrence.uri);
        const scope = cache?.scopes.get(occurrence.scopeId);
        if (scope?.kind !== 'file') {
            return occurrence.symbolId;
        }

        const directoryScope = this.getProjectDirectoryScopes().get(occurrence.uri) ?? occurrence.uri;
        return `${occurrence.namespace}:${directoryScope}:${occurrence.name}`;
    }

    private getEffectiveVariableScopeKey(occurrence: SymbolOccurrence): string {
        if (occurrence.namespace === 'cache-variable' || occurrence.namespace === 'environment-variable') {
            return `${occurrence.namespace}:${this.entryFile}`;
        }

        const cache = this.getCache(occurrence.uri);
        const scope = cache?.scopes.get(occurrence.scopeId);
        if (scope?.kind === 'file') {
            return `${occurrence.namespace}:${this.getProjectDirectoryScopes().get(occurrence.uri) ?? occurrence.uri}`;
        }
        return `${occurrence.namespace}:${occurrence.scopeId}`;
    }

    private getProjectDirectoryScopes(): Map<string, string> {
        if (this.projectDirectoryScopes) {
            return this.projectDirectoryScopes;
        }

        const scopes = new Map<string, string>();
        const stack: Array<{ uri: string; directoryScope: string }> = [{
            uri: this.entryFile,
            directoryScope: this.entryFile,
        }];
        while (stack.length > 0) {
            const current = stack.pop()!;
            if (scopes.has(current.uri)) {
                continue;
            }
            scopes.set(current.uri, current.directoryScope);

            for (const dependency of this.getAvailableDependencies(current.uri)) {
                stack.push({
                    uri: dependency.uri,
                    directoryScope: dependency.type === 'include' ? current.directoryScope : dependency.uri,
                });
            }
        }

        if (!scopes.has(this.currentFile)) {
            scopes.set(this.currentFile, this.currentFile);
        }
        this.projectDirectoryScopes = scopes;
        return scopes;
    }

    private getProjectDeclarations(namespace: SymbolNamespace, canonicalName: string): SymbolOccurrence[] {
        const key = `${namespace}\0${canonicalName}`;
        let declarations = this.projectDeclarations.get(key);
        if (!declarations) {
            declarations = this.getDeclarations(this.getProjectFiles(), namespace, canonicalName);
            this.projectDeclarations.set(key, declarations);
        }
        return declarations;
    }

    private selectProjectDeclarations(occurrence: SymbolOccurrence): SymbolOccurrence[] {
        const declarations = this.getProjectDeclarations(occurrence.namespace, occurrence.canonicalName);
        if (occurrence.namespace !== 'command') {
            return declarations;
        }

        const occurrenceCache = this.getCache(occurrence.uri);
        if (occurrenceCache && this.isInsideFunctionOrMacro(occurrenceCache, occurrence.scopeId)) {
            return declarations;
        }

        const executionOrder = this.getExecutionOrder();
        if (this.repeatedExecutionOccurrences?.has(occurrenceKey(occurrence))) {
            return declarations;
        }
        const referenceOrder = executionOrder.get(occurrenceKey(occurrence));
        if (referenceOrder === undefined) {
            return declarations;
        }

        const precedingDeclarations = declarations
            .map(declaration => ({
                declaration,
                order: executionOrder.get(occurrenceKey(declaration)),
                uncertain: this.uncertainExecutionOccurrences?.has(occurrenceKey(declaration)) ?? false,
            }))
            .filter((candidate): candidate is { declaration: SymbolOccurrence; order: number; uncertain: boolean } =>
                candidate.order !== undefined && candidate.order <= referenceOrder
            );
        if (precedingDeclarations.length === 0) {
            return declarations;
        }

        const uncertainDeclarations = precedingDeclarations.filter(candidate => candidate.uncertain);
        const certainDeclarations = precedingDeclarations.filter(candidate => !candidate.uncertain);
        const latestCertainOrder = certainDeclarations.length > 0
            ? Math.max(...certainDeclarations.map(candidate => candidate.order))
            : Number.NEGATIVE_INFINITY;
        const latestUncertainOrder = uncertainDeclarations.length > 0
            ? Math.max(...uncertainDeclarations.map(candidate => candidate.order))
            : Number.NEGATIVE_INFINITY;

        if (latestUncertainOrder > latestCertainOrder) {
            return precedingDeclarations
                .filter(candidate => candidate.order >= latestCertainOrder)
                .map(candidate => candidate.declaration);
        }

        const latestOrder = Math.max(...certainDeclarations.map(candidate => candidate.order));
        return precedingDeclarations
            .filter(candidate => !candidate.uncertain && candidate.order === latestOrder)
            .map(candidate => candidate.declaration);
    }

    private getExecutionOrder(): Map<string, number> {
        if (this.executionOrder) {
            return this.executionOrder;
        }

        const result = new Map<string, number>();
        const uncertainOccurrences = new Set<string>();
        const repeatedOccurrences = new Set<string>();
        const visitedFiles = new Set<string>();
        let sequence = 0;
        const visit = (uri: string, active: Set<string>, inheritedUncertainty: boolean): void => {
            if (active.has(uri)) {
                return;
            }
            const cache = this.getCache(uri);
            if (!cache) {
                return;
            }
            const repeatedVisit = visitedFiles.has(uri);
            visitedFiles.add(uri);

            const nextActive = new Set(active);
            nextActive.add(uri);
            const occurrencesByOrder = new Map<number, SymbolOccurrence[]>();
            for (const occurrence of uniqueOccurrences(cache.occurrences)) {
                const entries = occurrencesByOrder.get(occurrence.order) ?? [];
                entries.push(occurrence);
                occurrencesByOrder.set(occurrence.order, entries);
            }
            const dependenciesByOrder = new Map<number, Dependency[]>();
            for (const dependency of this.getAvailableDependencies(uri)) {
                const dependencyOrder = dependency.order ?? Number.MAX_SAFE_INTEGER;
                const entries = dependenciesByOrder.get(dependencyOrder) ?? [];
                entries.push(dependency);
                dependenciesByOrder.set(dependencyOrder, entries);
            }

            const orders = Array.from(new Set([
                ...occurrencesByOrder.keys(),
                ...dependenciesByOrder.keys(),
            ])).sort((left, right) => left - right);
            for (const order of orders) {
                for (const occurrence of occurrencesByOrder.get(order) ?? []) {
                    const key = occurrenceKey(occurrence);
                    if (repeatedVisit || repeatedOccurrences.has(key)) {
                        result.delete(key);
                        repeatedOccurrences.add(key);
                        uncertainOccurrences.add(key);
                        sequence++;
                        continue;
                    }
                    result.set(key, sequence++);
                    if (inheritedUncertainty || cache.uncertainOrders.has(order)) {
                        uncertainOccurrences.add(key);
                    }
                }
                for (const dependency of dependenciesByOrder.get(order) ?? []) {
                    visit(dependency.uri, nextActive, inheritedUncertainty || dependency.uncertain === true || cache.uncertainOrders.has(order));
                }
            }
        };

        visit(this.entryFile, new Set(), false);
        if (!result.size && this.currentFile !== this.entryFile) {
            visit(this.currentFile, new Set(), false);
        }
        this.uncertainExecutionOccurrences = uncertainOccurrences;
        this.repeatedExecutionOccurrences = repeatedOccurrences;
        this.executionOrder = result;
        return result;
    }

    private isInsideFunctionOrMacro(cache: FileSymbolCache, scopeId: string): boolean {
        let currentScopeId: string | undefined = scopeId;
        while (currentScopeId) {
            const scope = cache.scopes.get(currentScopeId);
            if (scope?.kind === 'function' || scope?.kind === 'macro') {
                return true;
            }
            currentScopeId = scope?.parentId;
        }
        return false;
    }

    private getAllDeclarations(namespace: SymbolNamespace, canonicalName: string): SymbolOccurrence[] {
        const key = `${namespace}\0${canonicalName}`;
        let declarations = this.workspaceDeclarations.get(key);
        if (!declarations) {
            declarations = this.getDeclarations(
                this.symbolIndex.getAllCaches()
                    .map(cache => cache.uri)
                    .filter(uri => !this.symbolIndex.isBuiltinModuleUri(uri)),
                namespace,
                canonicalName,
            );
            this.workspaceDeclarations.set(key, declarations);
        }
        return declarations;
    }

    private getDeclarations(files: string[], namespace: SymbolNamespace, canonicalName: string): SymbolOccurrence[] {
        const declarations: SymbolOccurrence[] = [];
        for (const uri of files) {
            const cache = this.getCache(uri);
            if (!cache) {
                continue;
            }
            declarations.push(...cache.getOccurrences(namespace, canonicalName).filter(occurrence =>
                occurrence.role === 'declaration'
                && occurrence.symbolId !== undefined
            ));
        }
        return uniqueOccurrences(declarations);
    }

    private getProjectOccurrences(namespace: SymbolNamespace, canonicalName: string): SymbolOccurrence[] {
        const key = `${namespace}\0${canonicalName}`;
        const cached = this.projectOccurrences.get(key);
        if (cached) {
            return cached;
        }

        const occurrences: SymbolOccurrence[] = [];
        for (const uri of this.getProjectFiles()) {
            const cache = this.getCache(uri);
            if (!cache) {
                continue;
            }
            occurrences.push(...cache.getOccurrences(namespace, canonicalName));
        }
        const result = uniqueOccurrences(occurrences);
        this.projectOccurrences.set(key, result);
        return result;
    }

    private hasCompleteRenameCoverage(namespaces: SymbolNamespace[], canonicalName: string): boolean {
        for (const uri of this.getProjectFiles()) {
            const cache = this.getCache(uri);
            if (!cache) {
                return false;
            }
            if (namespaces.some(namespace => !cache.isRenameSafe(namespace, canonicalName))) {
                return false;
            }
        }
        return true;
    }

    private toLocation(occurrence: SymbolOccurrence): Location {
        return { uri: occurrence.uri, range: occurrence.range };
    }
}
