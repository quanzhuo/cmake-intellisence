import * as fs from 'fs';
import * as path from 'path';
import {
    FileApiCacheEntrySnapshot,
    FileApiCMakeInputSnapshot,
    FileApiRawSnapshot,
    FileApiTargetSnapshot,
    FileApiToolchainSnapshot,
} from './fileApiSnapshot';

type FileApiObjectVersion = {
    major: number;
    minor?: number;
};

type FileApiObjectReference = {
    kind?: string;
    version?: FileApiObjectVersion;
    jsonFile?: string;
};

type FileApiReplyIndex = {
    objects?: FileApiObjectReference[];
};

type FileApiCacheObject = {
    entries?: Array<{
        name: string;
        value?: string;
        type?: string;
        properties?: Array<{ name?: string; value?: string }>;
    }>;
};

type FileApiCMakeFilesObject = {
    inputs?: Array<{
        path: string;
        isGenerated?: boolean;
        isExternal?: boolean;
    }>;
    globsDependent?: Array<{
        paths?: string[];
        files?: string[];
    }>;
};

type FileApiToolchainsObject = {
    toolchains?: Array<{
        language: string;
        compiler?: {
            path?: string;
            commandFragment?: string;
            id?: string;
            version?: string;
            target?: string;
            implicit?: {
                includeDirectories?: string[];
                linkDirectories?: string[];
                linkFrameworkDirectories?: string[];
                linkLibraries?: string[];
            };
        };
        sourceFileExtensions?: string[];
    }>;
};

type FileApiCodeModelObject = {
    configurations?: Array<{
        targets?: Array<{
            id: string;
            name: string;
            jsonFile?: string;
            imported?: boolean;
            abstract?: boolean;
            symbolic?: boolean;
            isGeneratorProvided?: boolean;
            folder?: { name?: string };
            paths?: {
                source?: string;
                build?: string;
            };
            nameOnDisk?: string;
            artifacts?: Array<{ path?: string }>;
            dependencies?: Array<{ id?: string }>;
        }>;
        abstractTargets?: Array<{
            compileGroups?: Array<{
                includes?: Array<{ path?: string }>;
            }>;
            defines?: Array<{ define?: string }>;
            backtraceGraph?: {
                files?: string[];
                commands?: string[];
            };
            id: string;
            name: string;
            jsonFile?: string;
        }>;
    }>;
};

type FileApiTargetObject = {
    id?: string;
    name?: string;
    type?: string;
    imported?: boolean;
    abstract?: boolean;
    symbolic?: boolean;
    isGeneratorProvided?: boolean;
    folder?: { name?: string };
    paths?: {
        source?: string;
        build?: string;
    };
    nameOnDisk?: string;
    artifacts?: Array<{ path?: string }>;
    dependencies?: Array<{ id?: string }>;
    sources?: Array<{ path?: string; isGenerated?: boolean }>;
    interfaceSources?: Array<{ path?: string; isGenerated?: boolean }>;
    compileGroups?: Array<{
        includes?: Array<{ path?: string }>;
    }>;
    defines?: Array<{ define?: string }>;
    backtraceGraph?: {
        files?: string[];
        commands?: string[];
    };
};

function readJsonFile<T>(filePath: string): T {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read JSON file ${filePath}: ${message}`);
    }
}

function tryReadJsonFile<T>(filePath: string): T | null {
    try {
        return readJsonFile<T>(filePath);
    } catch {
        return null;
    }
}

function findObjectReference(index: FileApiReplyIndex, kind: string, majorVersion: number): FileApiObjectReference | null {
    return index.objects?.find((candidate) => {
        return candidate.kind === kind && candidate.version?.major === majorVersion && typeof candidate.jsonFile === 'string';
    }) ?? null;
}

function getCacheEntriesByName(cacheObject: FileApiCacheObject | null): Record<string, FileApiCacheEntrySnapshot> {
    const entries: Record<string, FileApiCacheEntrySnapshot> = {};
    for (const entry of cacheObject?.entries ?? []) {
        entries[entry.name] = {
            name: entry.name,
            type: entry.type,
            value: entry.value,
            help: entry.properties?.find((property) => property.name === 'HELPSTRING')?.value,
        };
    }

    return entries;
}

function getCMakeInputs(cmakeFilesObject: FileApiCMakeFilesObject | null): FileApiCMakeInputSnapshot[] {
    return (cmakeFilesObject?.inputs ?? []).map((input) => {
        return {
            path: input.path,
            isGenerated: input.isGenerated,
            isExternal: input.isExternal,
        };
    });
}

function getGlobDependencies(cmakeFilesObject: FileApiCMakeFilesObject | null): string[] {
    return Array.from(new Set((cmakeFilesObject?.globsDependent ?? []).flatMap((glob) => glob.paths ?? glob.files ?? [])));
}

function getToolchainsByLanguage(toolchainsObject: FileApiToolchainsObject | null): Record<string, FileApiToolchainSnapshot> {
    const toolchains: Record<string, FileApiToolchainSnapshot> = {};
    for (const toolchain of toolchainsObject?.toolchains ?? []) {
        toolchains[toolchain.language] = {
            language: toolchain.language,
            compilerPath: toolchain.compiler?.path,
            compilerCommandFragment: toolchain.compiler?.commandFragment,
            compilerId: toolchain.compiler?.id,
            compilerVersion: toolchain.compiler?.version,
            target: toolchain.compiler?.target,
            implicitIncludeDirectories: toolchain.compiler?.implicit?.includeDirectories ?? [],
            implicitLinkDirectories: toolchain.compiler?.implicit?.linkDirectories ?? [],
            implicitLinkFrameworkDirectories: toolchain.compiler?.implicit?.linkFrameworkDirectories ?? [],
            implicitLinkLibraries: toolchain.compiler?.implicit?.linkLibraries ?? [],
            sourceFileExtensions: toolchain.sourceFileExtensions ?? [],
        };
    }

    return toolchains;
}

function loadTargetSnapshot(codemodelFilePath: string, targetReference: { id: string; name: string; jsonFile?: string }): FileApiTargetSnapshot {
    const targetSnapshot: FileApiTargetSnapshot = {
        id: targetReference.id,
        name: targetReference.name,
        jsonFile: targetReference.jsonFile,
    };

    if (!targetReference.jsonFile) {
        return targetSnapshot;
    }

    const targetFilePath = path.resolve(path.dirname(codemodelFilePath), targetReference.jsonFile);
    if (!fs.existsSync(targetFilePath)) {
        return targetSnapshot;
    }

    const targetObject = tryReadJsonFile<FileApiTargetObject>(targetFilePath);
    if (!targetObject) {
        return targetSnapshot;
    }
    const sourcePaths = Array.from(new Set([
        ...(targetObject.sources ?? []).map((source) => source.path).filter((sourcePath): sourcePath is string => typeof sourcePath === 'string'),
        ...(targetObject.interfaceSources ?? []).map((source) => source.path).filter((sourcePath): sourcePath is string => typeof sourcePath === 'string'),
    ]));
    const directSources = (targetObject.sources ?? []).filter((source) => typeof source.path === 'string');
    const interfaceSources = (targetObject.interfaceSources ?? []).filter((source) => typeof source.path === 'string');
    const generatedSourcePaths = Array.from(new Set([
        ...directSources.filter((source) => source.isGenerated).map((source) => source.path as string),
        ...interfaceSources.filter((source) => source.isGenerated).map((source) => source.path as string),
    ]));
    const includeDirectories = Array.from(new Set((targetObject.compileGroups ?? [])
        .flatMap((group) => group.includes ?? [])
        .map((include) => include.path)
        .filter((includePath): includePath is string => typeof includePath === 'string')));
    const compileDefinitions = Array.from(new Set((targetObject.defines ?? [])
        .map((define) => define.define)
        .filter((define): define is string => typeof define === 'string')));
    const artifactPaths = Array.from(new Set((targetObject.artifacts ?? [])
        .map((artifact) => artifact.path)
        .filter((artifactPath): artifactPath is string => typeof artifactPath === 'string')));
    const dependencyIds = Array.from(new Set((targetObject.dependencies ?? [])
        .map((dependency) => dependency.id)
        .filter((dependencyId): dependencyId is string => typeof dependencyId === 'string')));

    return {
        id: targetObject.id ?? targetReference.id,
        name: targetObject.name ?? targetReference.name,
        type: targetObject.type,
        sourcePaths,
        generatedSourcePaths,
        includeDirectories,
        compileDefinitions,
        artifactPaths,
        dependencyIds,
        sourceDirectory: targetObject.paths?.source,
        buildDirectory: targetObject.paths?.build,
        folderName: targetObject.folder?.name,
        nameOnDisk: targetObject.nameOnDisk,
        imported: targetObject.imported,
        abstract: targetObject.abstract,
        symbolic: targetObject.symbolic,
        isGeneratorProvided: targetObject.isGeneratorProvided,
        backtraceFiles: targetObject.backtraceGraph?.files ?? [],
        backtraceCommands: targetObject.backtraceGraph?.commands ?? [],
        jsonFile: targetReference.jsonFile,
    };
}

function getTargets(codemodelFilePath: string, codemodelObject: FileApiCodeModelObject | null): { byName: Record<string, FileApiTargetSnapshot>; byId: Record<string, FileApiTargetSnapshot> } {
    const byName: Record<string, FileApiTargetSnapshot> = {};
    const byId: Record<string, FileApiTargetSnapshot> = {};

    for (const configuration of codemodelObject?.configurations ?? []) {
        const targetReferences = [
            ...(configuration.targets ?? []),
            ...(configuration.abstractTargets ?? []),
        ];

        for (const targetReference of targetReferences) {
            if (byId[targetReference.id]) {
                continue;
            }

            const targetSnapshot = loadTargetSnapshot(codemodelFilePath, targetReference);
            byId[targetSnapshot.id] = targetSnapshot;
            byName[targetSnapshot.name] = targetSnapshot;
        }
    }

    return { byName, byId };
}

export function getFileApiReplyDirectory(buildDirectory: string): string {
    return path.join(buildDirectory, '.cmake', 'api', 'v1', 'reply');
}

export function findLatestFileApiIndexFile(replyDirectory: string): string | null {
    if (!fs.existsSync(replyDirectory)) {
        return null;
    }

    const candidates = fs.readdirSync(replyDirectory)
        .filter((entry) => /^index-.*\.json$/i.test(entry))
        .sort((left, right) => left.localeCompare(right));

    return candidates.at(-1) ?? null;
}

export function loadFileApiRawSnapshot(buildDirectory: string): FileApiRawSnapshot | null {
    const replyDirectory = getFileApiReplyDirectory(buildDirectory);
    const indexFile = findLatestFileApiIndexFile(replyDirectory);
    if (!indexFile) {
        return null;
    }

    const indexFilePath = path.join(replyDirectory, indexFile);
    const indexStat = fs.statSync(indexFilePath);
    const replyIndex = readJsonFile<FileApiReplyIndex>(indexFilePath);

    const cacheReference = findObjectReference(replyIndex, 'cache', 2);
    const cmakeFilesReference = findObjectReference(replyIndex, 'cmakeFiles', 1);
    const toolchainsReference = findObjectReference(replyIndex, 'toolchains', 1);
    const codemodelReference = findObjectReference(replyIndex, 'codemodel', 2);

    const cacheObject = cacheReference?.jsonFile
        ? tryReadJsonFile<FileApiCacheObject>(path.resolve(path.dirname(indexFilePath), cacheReference.jsonFile))
        : null;
    const cmakeFilesObject = cmakeFilesReference?.jsonFile
        ? tryReadJsonFile<FileApiCMakeFilesObject>(path.resolve(path.dirname(indexFilePath), cmakeFilesReference.jsonFile))
        : null;
    const toolchainsObject = toolchainsReference?.jsonFile
        ? tryReadJsonFile<FileApiToolchainsObject>(path.resolve(path.dirname(indexFilePath), toolchainsReference.jsonFile))
        : null;

    let codemodelFilePath: string | null = null;
    let codemodelObject: FileApiCodeModelObject | null = null;
    if (codemodelReference?.jsonFile) {
        codemodelFilePath = path.resolve(path.dirname(indexFilePath), codemodelReference.jsonFile);
        codemodelObject = tryReadJsonFile<FileApiCodeModelObject>(codemodelFilePath);
    }

    const targets = codemodelFilePath && codemodelObject
        ? getTargets(codemodelFilePath, codemodelObject)
        : { byName: {}, byId: {} };

    return {
        replyDirectory,
        indexFile,
        indexMtimeMs: indexStat.mtimeMs,
        cacheEntriesByName: getCacheEntriesByName(cacheObject),
        cmakeInputs: getCMakeInputs(cmakeFilesObject),
        globDependencies: getGlobDependencies(cmakeFilesObject),
        toolchainsByLanguage: getToolchainsByLanguage(toolchainsObject),
        targetsByName: targets.byName,
        targetsById: targets.byId,
    };
}