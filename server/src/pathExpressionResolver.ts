import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { FlatCommand } from './flatCommands';
import { SymbolIndex } from './symbolIndex';

const MAX_BEST_EFFORT_CANDIDATES = 1;

export interface PathExpressionResolverOptions {
    symbolIndex: SymbolIndex;
    getFlatCommands: (uri: string) => Promise<FlatCommand[]>;
    entryFile: URI;
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
    private readonly visibleFilesSignatureCache = new Map<string, string>();

    constructor(private readonly options: PathExpressionResolverOptions) {
    }

    private getVisibleFilesSignature(sourceUri: URI): string {
        const cacheKey = sourceUri.toString();
        const existing = this.visibleFilesSignatureCache.get(cacheKey);
        if (existing) {
            return existing;
        }

        const visibleFiles = this.options.symbolIndex.getVisibleFilesForVariable(this.options.entryFile.toString(), cacheKey);
        if (!visibleFiles.includes(cacheKey)) {
            visibleFiles.push(cacheKey);
        }

        const signature = visibleFiles.join('\0');
        this.visibleFilesSignatureCache.set(cacheKey, signature);
        return signature;
    }

    private createRequestCacheKey(kind: 'expand' | 'file', request: PathExpressionRequest): string {
        return [
            kind,
            this.options.entryFile.toString(),
            request.sourceUri.toString(),
            request.maxLine.toString(),
            request.argText,
            this.getVisibleFilesSignature(request.sourceUri),
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
        return path.isAbsolute(argText)
            || /^\$\{(CMAKE_CURRENT_LIST_DIR|CMAKE_CURRENT_SOURCE_DIR|CMAKE_SOURCE_DIR|PROJECT_SOURCE_DIR)\}/.test(argText);
    }

    private getMissingVariableResult(variableName: string): ExpandedPathResult {
        return {
            expandedPath: null,
            unresolvedVariables: [variableName],
            reason: 'unresolved-variable',
        };
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

    private isSimpleSetValue(value: string): boolean {
        // Phase 2 intentionally supports only literal path fragments plus ${VAR}
        // interpolation. List values, env/cache references, and generator
        // expressions are left unresolved for now.
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

    private async resolveVariableValue(
        variableName: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string>,
        depth: number,
    ): Promise<string | null> {
        const result = await this.resolveVariableValueDetailed(variableName, sourceUri, maxLine, seen, depth);
        return result.expandedPath;
    }

    private async resolveVariableValueDetailed(
        variableName: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string>,
        depth: number,
    ): Promise<ExpandedPathResult> {
        const recursionKey = `${sourceUri.toString()}::${variableName}`;
        if (seen.has(recursionKey)) {
            return {
                expandedPath: null,
                unresolvedVariables: [variableName],
                reason: 'cycle-detected',
            };
        }

        seen.add(recursionKey);
        try {
            const visibleFiles = this.options.symbolIndex.getVisibleFilesForVariable(this.options.entryFile.toString(), sourceUri.toString());
            if (!visibleFiles.includes(sourceUri.toString())) {
                visibleFiles.push(sourceUri.toString());
            }

            for (let fileIndex = visibleFiles.length - 1; fileIndex >= 0; fileIndex--) {
                const candidateUri = visibleFiles[fileIndex];
                const commands = await this.options.getFlatCommands(candidateUri);
                for (let commandIndex = commands.length - 1; commandIndex >= 0; commandIndex--) {
                    const candidate = commands[commandIndex];
                    if (candidate.commandName.toLowerCase() !== 'set') {
                        continue;
                    }

                    if (candidateUri === sourceUri.toString() && candidate.start.line - 1 > maxLine) {
                        continue;
                    }

                    const args = candidate.argument_list();
                    if (args[0]?.getText() !== variableName) {
                        continue;
                    }

                    const value = this.getSimpleSetValue(candidate);
                    if (!value) {
                        continue;
                    }

                    return this.expandPathVariablesDetailed(
                        value,
                        URI.parse(candidateUri),
                        candidate.start.line - 1,
                        seen,
                        depth + 1,
                    );
                }
            }

            return this.getMissingVariableResult(variableName);
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
        if (depth > 8) {
            return {
                expandedPath: null,
                unresolvedVariables: [],
                reason: 'recursion-limit',
            };
        }

        const matches = Array.from(argText.matchAll(/\$\{([^}]+)\}/g));
        if (matches.length === 0) {
            return {
                expandedPath: path.normalize(argText),
                unresolvedVariables: [],
                reason: 'resolved',
            };
        }

        let expanded = argText;
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
        if (depth > 8) {
            return null;
        }

        const matches = Array.from(argText.matchAll(/\$\{([^}]+)\}/g));
        if (matches.length === 0) {
            return this.sanitizeBestEffortPath(argText, originalArgText);
        }

        let expanded = argText;
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
        return path.isAbsolute(argText)
            ? URI.file(path.normalize(argText))
            : URI.file(path.resolve(path.dirname(sourceUri.fsPath), argText));
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