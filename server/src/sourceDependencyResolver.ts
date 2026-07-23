import * as fs from 'fs';
import * as path from 'path';
import { URI, Utils } from 'vscode-uri';
import { FlatCommand } from './flatCommands';
import { PathExpressionRequest, PathExpressionResolver } from './pathExpressionResolver';
import { FileSymbolCache, SymbolIndex } from './symbolIndex';
import { getIncludeFileUri, getIncludeModuleUri, normalizeQuotedArgument } from './utils';

export interface SourceDependencyOptions {
    entryFile: string;
    getFlatCommands: (uri: string) => Promise<FlatCommand[]>;
}

function createPathExpressionRequest(cmd: FlatCommand, argText: string, sourceUri: URI, maxLine: number): PathExpressionRequest {
    return {
        commandName: cmd.commandName.toLowerCase(),
        argText,
        sourceUri,
        maxLine,
    };
}

export async function extractIncludeDependency(
    cmd: FlatCommand,
    cache: FileSymbolCache,
    baseDir: URI,
    symbolIndex: SymbolIndex,
    sourceUri: URI,
    order: number,
    uncertain: boolean,
    pathExpressionResolver?: PathExpressionResolver,
    options?: SourceDependencyOptions,
): Promise<void> {
    const includeArg = cmd.argument_list()[0];
    const includeText = includeArg?.getText();
    const maxLine = includeArg?.start.line ? includeArg.start.line - 1 : 0;
    if (!includeText) {
        return;
    }

    const resolvedFileUri = pathExpressionResolver
        ? await pathExpressionResolver.resolveFileRequest(createPathExpressionRequest(cmd, includeText, sourceUri, maxLine))
        : null;
    const localFileUri = getIncludeFileUri(symbolIndex, baseDir, includeText);
    const sourceModuleUri = pathExpressionResolver && options
        ? await resolveModuleFromSourceConfiguration(
            includeText,
            sourceUri,
            order,
            cache,
            symbolIndex,
            pathExpressionResolver,
            options,
        )
        : null;
    const targetUri = resolvedFileUri
        ?? localFileUri
        ?? sourceModuleUri
        ?? getIncludeModuleUri(symbolIndex, includeText);
    if (targetUri) {
        cache.addDependency(targetUri.toString(), 'include', order, uncertain);
    }
}

async function resolveModuleFromSourceConfiguration(
    includeText: string,
    sourceUri: URI,
    sourceOrder: number,
    sourceCache: FileSymbolCache,
    symbolIndex: SymbolIndex,
    pathExpressionResolver: PathExpressionResolver,
    options: SourceDependencyOptions,
): Promise<URI | null> {
    const moduleName = normalizeQuotedArgument(includeText);
    if (!moduleName || moduleName.includes('/') || moduleName.includes('\\') || path.extname(moduleName) !== '') {
        return null;
    }

    let moduleDirectories: string[] = [];
    const sourceUriString = sourceUri.toString();
    const uniqueDirectories = (directories: string[]): string[] => Array.from(new Set(directories));
    const applyModulePathCommand = async (
        candidate: FlatCommand,
        candidateUri: string,
        uncertain: boolean,
    ): Promise<void> => {
        const commandName = candidate.commandName.toLowerCase();
        const args = candidate.argument_list();
        let operation: 'set' | 'append' | 'prepend' | null = null;
        let values: string[] = [];
        if (commandName === 'set' && args[0]?.getText() === 'CMAKE_MODULE_PATH') {
            operation = 'set';
            const suffixIndex = args.findIndex((arg, index) =>
                index > 0 && (arg.getText().toUpperCase() === 'CACHE' || arg.getText().toUpperCase() === 'PARENT_SCOPE')
            );
            values = (suffixIndex === -1 ? args.slice(1) : args.slice(1, suffixIndex)).map(arg => arg.getText());
        } else if (commandName === 'list'
            && args[1]?.getText() === 'CMAKE_MODULE_PATH'
            && (args[0]?.getText().toUpperCase() === 'APPEND' || args[0]?.getText().toUpperCase() === 'PREPEND')) {
            operation = args[0].getText().toUpperCase() === 'APPEND' ? 'append' : 'prepend';
            values = args.slice(2).map(arg => arg.getText());
        }

        if (!operation) {
            return;
        }

        const expandedDirectories: string[] = [];
        for (const value of values.flatMap(value => normalizeQuotedArgument(value).split(';'))) {
            if (!value) {
                continue;
            }
            if (value === '${CMAKE_MODULE_PATH}') {
                expandedDirectories.push(...moduleDirectories);
                continue;
            }
            const expanded = await pathExpressionResolver.expandPathExpression({
                commandName,
                argText: value,
                sourceUri: URI.parse(candidateUri),
                maxLine: candidate.start.line - 1,
            });
            if (expanded) {
                expandedDirectories.push(path.isAbsolute(expanded)
                    ? path.normalize(expanded)
                    : path.resolve(path.dirname(URI.parse(candidateUri).fsPath), expanded));
            }
        }

        const previousDirectories = moduleDirectories;
        if (operation === 'set') {
            moduleDirectories = expandedDirectories;
        } else if (operation === 'append') {
            moduleDirectories.push(...expandedDirectories);
        } else {
            moduleDirectories.unshift(...expandedDirectories);
        }
        moduleDirectories = uncertain
            ? uniqueDirectories([...moduleDirectories, ...previousDirectories])
            : uniqueDirectories(moduleDirectories);
    };

    const visit = async (uri: string, active: Set<string>, inheritedUncertainty: boolean): Promise<boolean> => {
        if (active.has(uri)) {
            return false;
        }

        const cache = uri === sourceUriString ? sourceCache : symbolIndex.getCache(uri);
        const commands = await options.getFlatCommands(uri);
        const dependenciesByOrder = new Map<number, FileSymbolCache['dependencies']>();
        const dependencies = uri === sourceUriString
            ? sourceCache.dependencies
            : symbolIndex.getAvailableDependencies(uri, options.entryFile);
        for (const dependency of dependencies) {
            const dependencyOrder = dependency.order ?? Number.MAX_SAFE_INTEGER;
            const dependencies = dependenciesByOrder.get(dependencyOrder) ?? [];
            dependencies.push(dependency);
            dependenciesByOrder.set(dependencyOrder, dependencies);
        }

        const nextActive = new Set(active);
        nextActive.add(uri);
        for (const [order, candidate] of commands.entries()) {
            if (uri === sourceUriString && order > sourceOrder) {
                return true;
            }

            const deferred = cache ? isDeferredOrder(cache, order) : false;
            await applyModulePathCommand(
                candidate,
                uri,
                inheritedUncertainty || deferred || (cache?.conditionalOrders.has(order) ?? false),
            );

            for (const dependency of dependenciesByOrder.get(order) ?? []) {
                const previousDirectories = [...moduleDirectories];
                const dependencyIsUncertain = inheritedUncertainty || deferred || dependency.uncertain === true;
                const foundTarget = await visit(dependency.uri, nextActive, dependencyIsUncertain);
                if (foundTarget) {
                    return true;
                }
                if (dependency.type === 'subdirectory') {
                    moduleDirectories = previousDirectories;
                } else if (dependencyIsUncertain) {
                    moduleDirectories = uniqueDirectories([...moduleDirectories, ...previousDirectories]);
                }
            }
        }

        for (const dependency of dependenciesByOrder.get(Number.MAX_SAFE_INTEGER) ?? []) {
            const previousDirectories = [...moduleDirectories];
            const foundTarget = await visit(dependency.uri, nextActive, inheritedUncertainty || dependency.uncertain === true);
            if (foundTarget) {
                return true;
            }
            if (dependency.type === 'subdirectory') {
                moduleDirectories = previousDirectories;
            }
        }
        return uri === sourceUriString;
    };

    const foundFromEntry = await visit(options.entryFile, new Set(), false);
    if (!foundFromEntry && options.entryFile !== sourceUriString) {
        moduleDirectories = [];
        await visit(sourceUriString, new Set(), false);
    }

    for (const directory of moduleDirectories) {
        const candidate = path.join(directory, `${moduleName}.cmake`);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return URI.file(candidate);
        }
    }
    return null;
}

function isDeferredOrder(cache: FileSymbolCache, order: number): boolean {
    const commandOccurrence = cache.getOccurrencesAtOrder(order).find(occurrence =>
        occurrence.namespace === 'command'
    );
    let scopeId = commandOccurrence?.scopeId;
    while (scopeId) {
        const scope = cache.scopes.get(scopeId);
        if (scope?.kind === 'function' || scope?.kind === 'macro') {
            return true;
        }
        scopeId = scope?.parentId;
    }
    return false;
}

export async function extractSubdirectoryDependency(
    cmd: FlatCommand,
    cache: FileSymbolCache,
    baseDir: URI,
    sourceUri: URI,
    order: number,
    uncertain: boolean,
    pathExpressionResolver?: PathExpressionResolver,
): Promise<void> {
    const directoryArg = cmd.argument_list()[0];
    const directoryText = directoryArg?.getText();
    const maxLine = directoryArg?.start.line ? directoryArg.start.line - 1 : 0;
    if (!directoryText) {
        return;
    }

    const expandedDirectory = pathExpressionResolver
        ? await pathExpressionResolver.expandPathExpression(createPathExpressionRequest(cmd, directoryText, sourceUri, maxLine))
        : directoryText;
    if (!expandedDirectory) {
        return;
    }

    const cmakeListsUri = path.isAbsolute(expandedDirectory)
        ? URI.file(path.join(path.normalize(expandedDirectory), 'CMakeLists.txt'))
        : Utils.joinPath(baseDir, expandedDirectory.replace(/\\/g, '/'), 'CMakeLists.txt');
    if (fs.existsSync(cmakeListsUri.fsPath)) {
        cache.addDependency(cmakeListsUri.toString(), 'subdirectory', order, uncertain);
    }
}
