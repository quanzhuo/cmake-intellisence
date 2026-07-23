import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { FlatCommand } from './flatCommands';
import { SymbolBindingResolver } from './symbolBinding';
import { FileSymbolCache, SymbolIndex } from './symbolIndex';

const MAX_BEST_EFFORT_CANDIDATES = 1;

export interface PathExpressionResolverOptions {
    symbolIndex: SymbolIndex;
    getFlatCommands: (uri: string) => Promise<FlatCommand[]>;
    entryFile: URI;
    buildDirectory?: string;
    buildDirectoriesBySourcePath?: Record<string, string>;
    cacheOverrides?: ReadonlyMap<string, FileSymbolCache>;
}

export interface PathExpressionRequest {
    commandName?: string;
    argText: string;
    sourceUri: URI;
    maxLine: number;
}

export type PathResolutionReason =
    | 'resolved'
    | 'unresolved-variable'
    | 'cycle-detected'
    | 'recursion-limit'
    | 'missing-file';

export interface ExpandedPathResult {
    expandedPath: string | null;
    unresolvedVariables: string[];
    reason: PathResolutionReason;
}

export interface FileExpressionResolutionResult {
    expandedPath: string | null;
    exactCandidates: URI[];
    bestEffortCandidates: URI[];
    unresolvedVariables: string[];
    reason: PathResolutionReason;
}

export class PathExpressionResolver {
    private readonly expandedRequestCache = new Map<string, Promise<ExpandedPathResult>>();
    private readonly fileRequestCache = new Map<string, Promise<FileExpressionResolutionResult>>();
    private readonly resolvedFileCache = new Map<string, URI | null>();

    constructor(private readonly options: PathExpressionResolverOptions) {
    }

    private createRequestCacheKey(kind: 'expand' | 'file', request: PathExpressionRequest): string {
        return [
            kind,
            this.options.entryFile.toString(),
            request.sourceUri.toString(),
            request.maxLine.toString(),
            request.argText,
        ].join('\0');
    }

    private getCachedRequestResult<TResult>(
        cache: Map<string, Promise<TResult>>,
        key: string,
        factory: () => Promise<TResult>,
    ): Promise<TResult> {
        const existing = cache.get(key);
        if (existing) {
            return existing;
        }

        const request = factory();
        cache.set(key, request);
        return request;
    }

    private startsWithAbsolutePathAnchor(argText: string): boolean {
        const normalizedArgText = this.normalizePathArgument(argText);
        return path.isAbsolute(normalizedArgText)
            || /^\$\{(CMAKE_CURRENT_LIST_DIR|CMAKE_CURRENT_SOURCE_DIR|CMAKE_SOURCE_DIR|PROJECT_SOURCE_DIR|CMAKE_BINARY_DIR|PROJECT_BINARY_DIR|CMAKE_CURRENT_BINARY_DIR)\}/.test(normalizedArgText);
    }

    private getMissingVariableResult(variableName: string): ExpandedPathResult {
        return {
            expandedPath: null,
            unresolvedVariables: [variableName],
            reason: 'unresolved-variable',
        };
    }

    private normalizePathKey(filePath: string): string {
        const normalized = path.normalize(filePath);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    private getCurrentBinaryDirectory(sourceUri: URI): string | null {
        const currentSourceDir = path.dirname(sourceUri.fsPath);
        const normalizedCurrentSourceDir = this.normalizePathKey(currentSourceDir);
        const mappedBuildDirectory = this.options.buildDirectoriesBySourcePath?.[normalizedCurrentSourceDir];
        if (mappedBuildDirectory) {
            return mappedBuildDirectory;
        }

        const rootDir = path.dirname(this.options.entryFile.fsPath);
        if (this.normalizePathKey(rootDir) === normalizedCurrentSourceDir) {
            return this.options.buildDirectory ?? null;
        }

        return null;
    }

    private getKnownPathVariableValue(name: string, sourceUri: URI): string | null {
        const sourceDir = path.dirname(sourceUri.fsPath);
        const rootDir = path.dirname(this.options.entryFile.fsPath);

        switch (name) {
            case 'CMAKE_CURRENT_LIST_DIR':
            case 'CMAKE_CURRENT_SOURCE_DIR':
                return sourceDir;
            case 'CMAKE_SOURCE_DIR':
            case 'PROJECT_SOURCE_DIR':
                return rootDir;
            case 'CMAKE_BINARY_DIR':
            case 'PROJECT_BINARY_DIR':
                return this.options.buildDirectory ?? null;
            case 'CMAKE_CURRENT_BINARY_DIR':
                return this.getCurrentBinaryDirectory(sourceUri);
            default:
                return null;
        }
    }

    private normalizeSetValue(argText: string): string {
        if ((argText.startsWith('"') && argText.endsWith('"')) ||
            (argText.startsWith("'") && argText.endsWith("'"))) {
            return argText.slice(1, -1);
        }

        return argText;
    }

    private normalizePathArgument(argText: string): string {
        if ((argText.startsWith('"') && argText.endsWith('"')) ||
            (argText.startsWith("'") && argText.endsWith("'"))) {
            return argText.slice(1, -1);
        }

        return argText;
    }

    private isSimpleSetValue(value: string): boolean {
        // Only deterministic scalar paths are safe to resolve statically. List
        // values, env/cache references, and generator expressions stay unresolved.
        return !value.includes(';')
            && !value.includes('$ENV{')
            && !value.includes('$CACHE{')
            && !value.includes('$<');
    }

    private getSimpleSetValue(command: FlatCommand): string | null {
        if (command.commandName.toLowerCase() !== 'set') {
            return null;
        }

        const args = command.argument_list();
        if (args.length !== 2) {
            return null;
        }

        const value = args[1]?.getText();
        if (!value) {
            return null;
        }

        const normalizedValue = this.normalizeSetValue(value);
        return this.isSimpleSetValue(normalizedValue) ? normalizedValue : null;
    }

    private async resolveVariableValueDetailed(
        variableName: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string>,
        depth: number,
    ): Promise<ExpandedPathResult> {
        const binding = new SymbolBindingResolver(
            this.options.symbolIndex,
            this.options.entryFile.toString(),
            sourceUri.toString(),
            this.options.cacheOverrides,
        ).resolveVariableAtLine(variableName, maxLine);
        if (binding.declarations.length !== 1) {
            return this.getMissingVariableResult(variableName);
        }

        const declaration = binding.declarations[0];
        const recursionKey = `${declaration.uri}::${declaration.order}::${declaration.namespace}::${declaration.canonicalName}`;
        if (seen.has(recursionKey)) {
            return {
                expandedPath: null,
                unresolvedVariables: [variableName],
                reason: 'cycle-detected',
            };
        }

        seen.add(recursionKey);
        try {
            const commands = await this.options.getFlatCommands(declaration.uri);
            const value = this.getSimpleSetValue(commands[declaration.order]);
            if (!value) {
                return this.getMissingVariableResult(variableName);
            }

            return this.expandPathVariablesDetailed(
                value,
                URI.parse(declaration.uri),
                declaration.range.start.line,
                seen,
                depth + 1,
            );
        } finally {
            seen.delete(recursionKey);
        }
    }

    public async expandPathVariables(
        argText: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string> = new Set(),
        depth = 0,
    ): Promise<string | null> {
        if (seen.size === 0 && depth === 0) {
            return this.expandPathExpression({ argText, sourceUri, maxLine });
        }

        const result = await this.expandPathVariablesDetailed(argText, sourceUri, maxLine, seen, depth);
        return result.expandedPath;
    }

    public async expandPathExpression(request: PathExpressionRequest): Promise<string | null> {
        const result = await this.expandPathExpressionDetailed(request);
        return result.expandedPath;
    }

    public async expandPathVariablesDetailed(
        argText: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string> = new Set(),
        depth = 0,
    ): Promise<ExpandedPathResult> {
        const normalizedArgText = this.normalizePathArgument(argText);
        if (depth > 8) {
            return {
                expandedPath: null,
                unresolvedVariables: [],
                reason: 'recursion-limit',
            };
        }

        const matches = Array.from(normalizedArgText.matchAll(/\$\{([^}]+)\}/g));
        if (matches.length === 0) {
            return {
                expandedPath: path.normalize(normalizedArgText),
                unresolvedVariables: [],
                reason: 'resolved',
            };
        }

        let expanded = normalizedArgText;
        for (const match of matches) {
            const placeholder = match[0];
            const variableName = match[1];
            const replacement = this.getKnownPathVariableValue(variableName, sourceUri);
            const replacementResult = replacement
                ? {
                    expandedPath: replacement,
                    unresolvedVariables: [],
                    reason: 'resolved' as const,
                }
                : await this.resolveVariableValueDetailed(variableName, sourceUri, maxLine, seen, depth + 1);

            if (!replacementResult.expandedPath) {
                return replacementResult.unresolvedVariables.length > 0
                    ? replacementResult
                    : this.getMissingVariableResult(variableName);
            }

            expanded = expanded.replace(placeholder, replacementResult.expandedPath);
        }

        if (expanded.includes('${')) {
            return this.expandPathVariablesDetailed(expanded, sourceUri, maxLine, seen, depth + 1);
        }

        return {
            expandedPath: path.normalize(expanded),
            unresolvedVariables: [],
            reason: 'resolved',
        };
    }

    public async expandPathExpressionDetailed(request: PathExpressionRequest): Promise<ExpandedPathResult> {
        return this.getCachedRequestResult(
            this.expandedRequestCache,
            this.createRequestCacheKey('expand', request),
            () => this.expandPathVariablesDetailed(request.argText, request.sourceUri, request.maxLine),
        );
    }

    private sanitizeBestEffortPath(expanded: string, originalArgText: string): string | null {
        let normalized = path.normalize(expanded);
        if (!this.startsWithAbsolutePathAnchor(originalArgText)) {
            normalized = normalized.replace(/^[\\/]+/, '');
        }

        if (normalized.length === 0 || normalized === '.') {
            return null;
        }

        return normalized;
    }

    private async expandPathVariablesBestEffort(
        argText: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string> = new Set(),
        depth = 0,
        originalArgText: string = argText,
    ): Promise<string | null> {
        const normalizedArgText = this.normalizePathArgument(argText);
        if (depth > 8) {
            return null;
        }

        const matches = Array.from(normalizedArgText.matchAll(/\$\{([^}]+)\}/g));
        if (matches.length === 0) {
            return this.sanitizeBestEffortPath(normalizedArgText, originalArgText);
        }

        let expanded = normalizedArgText;
        for (const match of matches) {
            const placeholder = match[0];
            const variableName = match[1];
            const replacement = this.getKnownPathVariableValue(variableName, sourceUri);
            const replacementResult = replacement
                ? {
                    expandedPath: replacement,
                    unresolvedVariables: [],
                    reason: 'resolved' as const,
                }
                : await this.resolveVariableValueDetailed(variableName, sourceUri, maxLine, seen, depth + 1);

            expanded = expanded.replace(placeholder, replacementResult.expandedPath ?? '');
        }

        if (expanded.includes('${')) {
            return this.expandPathVariablesBestEffort(expanded, sourceUri, maxLine, seen, depth + 1, originalArgText);
        }

        return this.sanitizeBestEffortPath(expanded, originalArgText);
    }

    private toCandidateUri(argText: string, sourceUri: URI): URI {
        const normalizedArgText = this.normalizePathArgument(argText);
        return path.isAbsolute(normalizedArgText)
            ? URI.file(path.normalize(normalizedArgText))
            : URI.file(path.resolve(path.dirname(sourceUri.fsPath), normalizedArgText));
    }

    public resolveExpandedFile(argText: string, sourceUri: URI): URI | null {
        const cacheKey = `${sourceUri.toString()}\0${argText}`;
        if (this.resolvedFileCache.has(cacheKey)) {
            return this.resolvedFileCache.get(cacheKey) ?? null;
        }

        const target = this.toCandidateUri(argText, sourceUri);

        if (!fs.existsSync(target.fsPath) || fs.statSync(target.fsPath).isDirectory()) {
            this.resolvedFileCache.set(cacheKey, null);
            return null;
        }

        this.resolvedFileCache.set(cacheKey, target);
        return target;
    }

    private async getBestEffortCandidates(
        argText: string,
        sourceUri: URI,
        maxLine: number,
        preferredExpandedPath?: string | null,
    ): Promise<URI[]> {
        const candidateTexts: string[] = [];
        if (preferredExpandedPath) {
            candidateTexts.push(preferredExpandedPath);
        }

        const bestEffortPath = await this.expandPathVariablesBestEffort(argText, sourceUri, maxLine);
        if (bestEffortPath) {
            candidateTexts.push(bestEffortPath);
        }

        return Array.from(new Set(candidateTexts))
            .slice(0, MAX_BEST_EFFORT_CANDIDATES)
            .map(candidate => this.toCandidateUri(candidate, sourceUri));
    }

    public async resolveFileExpression(argText: string, sourceUri: URI, maxLine: number): Promise<URI | null> {
        return this.resolveFileRequest({ argText, sourceUri, maxLine });
    }

    public async resolveFileRequest(request: PathExpressionRequest): Promise<URI | null> {
        const result = await this.resolveFileRequestDetailed(request);
        return result.exactCandidates[0] ?? null;
    }

    private async resolveFileExpressionDetailedUncached(argText: string, sourceUri: URI, maxLine: number): Promise<FileExpressionResolutionResult> {
        const expandedResult = await this.expandPathVariablesDetailed(argText, sourceUri, maxLine);
        if (!expandedResult.expandedPath) {
            return {
                expandedPath: null,
                exactCandidates: [],
                bestEffortCandidates: await this.getBestEffortCandidates(argText, sourceUri, maxLine),
                unresolvedVariables: expandedResult.unresolvedVariables,
                reason: expandedResult.reason,
            };
        }

        const resolvedUri = this.resolveExpandedFile(expandedResult.expandedPath, sourceUri);
        if (resolvedUri) {
            return {
                expandedPath: expandedResult.expandedPath,
                exactCandidates: [resolvedUri],
                bestEffortCandidates: [],
                unresolvedVariables: [],
                reason: 'resolved',
            };
        }

        return {
            expandedPath: expandedResult.expandedPath,
            exactCandidates: [],
            bestEffortCandidates: await this.getBestEffortCandidates(argText, sourceUri, maxLine, expandedResult.expandedPath),
            unresolvedVariables: [],
            reason: 'missing-file',
        };
    }

    public async resolveFileExpressionDetailed(argText: string, sourceUri: URI, maxLine: number): Promise<FileExpressionResolutionResult> {
        return this.resolveFileRequestDetailed({ argText, sourceUri, maxLine });
    }

    public async resolveFileRequestDetailed(request: PathExpressionRequest): Promise<FileExpressionResolutionResult> {
        return this.getCachedRequestResult(
            this.fileRequestCache,
            this.createRequestCacheKey('file', request),
            () => this.resolveFileExpressionDetailedUncached(request.argText, request.sourceUri, request.maxLine),
        );
    }
}
