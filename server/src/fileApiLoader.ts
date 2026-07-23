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
        directories?: Array<{
            source?: string;
            build?: string;
        }>;
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

type FileApiIndexIdentity = {
    replyDirectory: string;
    indexFile: string;
    indexFilePath: string;
    mtimeMs: number;
    ctimeMs: number;
    size: number;
};

const TARGET_LOAD_BATCH_SIZE = 12;
const MAX_SNAPSHOT_CACHE_ENTRIES = 16;
const snapshotCacheByIdentity = new Map<string, FileApiRawSnapshot>();
const snapshotLoadsByIdentity = new Map<string, Promise<FileApiRawSnapshot>>();

async function readJsonFile<T>(filePath: string): Promise<T> {
    try {
        return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as T;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read JSON file ${filePath}: ${message}`);
    }
}

async function tryReadJsonFile<T>(filePath: string): Promise<T | null> {
    try {
        return await readJsonFile<T>(filePath);
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

function getCacheEntryValue(cacheObject: FileApiCacheObject | null, entryName: string): string | null {
    for (const entry of cacheObject?.entries ?? []) {
        if (entry.name === entryName && typeof entry.value === 'string') {
            return entry.value;
        }
    }

    return null;
}

function normalizeDirectoryMapKey(filePath: string): string {
    const normalized = path.normalize(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveFileApiPath(basePath: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
        return path.normalize(relativePath);
    }

    // Tests and synthetic workspaces may use file URIs whose Windows fsPath is
    // rooted but drive-less (for example "\\test-workspace"). Preserve that
    // anchor instead of letting path.resolve inject the current drive.
    if (process.platform === 'win32' && /^[\\/](?![\\/])/.test(basePath)) {
        return path.normalize(path.join(basePath, relativePath));
    }

    return path.resolve(basePath, relativePath);
}

function getBuildDirectoriesBySourcePath(
    codemodelObject: FileApiCodeModelObject | null,
    sourceRoot: string | null,
    buildDirectory: string,
): Record<string, string> {
    const directoriesBySourcePath: Record<string, string> = {};
    if (!sourceRoot) {
        return directoriesBySourcePath;
    }

    for (const configuration of codemodelObject?.configurations ?? []) {
        for (const directory of configuration.directories ?? []) {
            if (typeof directory.source !== 'string' || typeof directory.build !== 'string') {
                continue;
            }

            const sourceDirectory = resolveFileApiPath(sourceRoot, directory.source);
            const binaryDirectory = resolveFileApiPath(buildDirectory, directory.build);
            directoriesBySourcePath[normalizeDirectoryMapKey(sourceDirectory)] = path.normalize(binaryDirectory);
        }
    }

    return directoriesBySourcePath;
}

async function loadTargetSnapshot(
    codemodelFilePath: string,
    targetReference: { id: string; name: string; jsonFile?: string },
): Promise<FileApiTargetSnapshot> {
    const targetSnapshot: FileApiTargetSnapshot = {
        id: targetReference.id,
        name: targetReference.name,
        jsonFile: targetReference.jsonFile,
    };

    if (!targetReference.jsonFile) {
        return targetSnapshot;
    }

    const targetFilePath = path.resolve(path.dirname(codemodelFilePath), targetReference.jsonFile);
    const targetObject = await tryReadJsonFile<FileApiTargetObject>(targetFilePath);
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

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

async function getTargets(
    codemodelFilePath: string,
    codemodelObject: FileApiCodeModelObject | null,
): Promise<{ byName: Record<string, FileApiTargetSnapshot>; byId: Record<string, FileApiTargetSnapshot> }> {
    const byName: Record<string, FileApiTargetSnapshot> = {};
    const byId: Record<string, FileApiTargetSnapshot> = {};
    const uniqueTargetReferences = new Map<string, { id: string; name: string; jsonFile?: string }>();

    for (const configuration of codemodelObject?.configurations ?? []) {
        const targetReferences = [
            ...(configuration.targets ?? []),
            ...(configuration.abstractTargets ?? []),
        ];

        for (const targetReference of targetReferences) {
            if (!uniqueTargetReferences.has(targetReference.id)) {
                uniqueTargetReferences.set(targetReference.id, targetReference);
            }
        }
    }

    const targetReferences = Array.from(uniqueTargetReferences.values());
    for (let offset = 0; offset < targetReferences.length; offset += TARGET_LOAD_BATCH_SIZE) {
        const batch = targetReferences.slice(offset, offset + TARGET_LOAD_BATCH_SIZE);
        const targetSnapshots = await Promise.all(
            batch.map(targetReference => loadTargetSnapshot(codemodelFilePath, targetReference)),
        );
        for (const targetSnapshot of targetSnapshots) {
            byId[targetSnapshot.id] = targetSnapshot;
            byName[targetSnapshot.name] = targetSnapshot;
        }
        if (offset + TARGET_LOAD_BATCH_SIZE < targetReferences.length) {
            await yieldToEventLoop();
        }
    }

    return { byName, byId };
}

export function getFileApiReplyDirectory(buildDirectory: string): string {
    return path.join(buildDirectory, '.cmake', 'api', 'v1', 'reply');
}

export async function findLatestFileApiIndexFile(replyDirectory: string): Promise<string | null> {
    let entries: string[];
    try {
        entries = await fs.promises.readdir(replyDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }

    const candidates = entries
        .filter((entry) => /^index-.*\.json$/i.test(entry))
        .sort((left, right) => left.localeCompare(right));

    return candidates.at(-1) ?? null;
}

function normalizeCacheKey(filePath: string): string {
    const normalized = path.resolve(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getIndexIdentityKey(identity: FileApiIndexIdentity): string {
    return [
        normalizeCacheKey(identity.indexFilePath),
        identity.mtimeMs,
        identity.ctimeMs,
        identity.size,
    ].join('\0');
}

function cacheSnapshot(identityKey: string, snapshot: FileApiRawSnapshot): void {
    snapshotCacheByIdentity.delete(identityKey);
    snapshotCacheByIdentity.set(identityKey, snapshot);
    while (snapshotCacheByIdentity.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
        const oldestKey = snapshotCacheByIdentity.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        snapshotCacheByIdentity.delete(oldestKey);
    }
}

async function getLatestIndexIdentity(replyDirectory: string): Promise<FileApiIndexIdentity | null> {
    const indexFile = await findLatestFileApiIndexFile(replyDirectory);
    if (!indexFile) {
        return null;
    }

    const indexFilePath = path.join(replyDirectory, indexFile);
    try {
        const stat = await fs.promises.stat(indexFilePath);
        return {
            replyDirectory,
            indexFile,
            indexFilePath,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            size: stat.size,
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function loadSnapshotForIndex(
    buildDirectory: string,
    identity: FileApiIndexIdentity,
): Promise<FileApiRawSnapshot> {
    const replyIndex = await readJsonFile<FileApiReplyIndex>(identity.indexFilePath);

    const cacheReference = findObjectReference(replyIndex, 'cache', 2);
    const cmakeFilesReference = findObjectReference(replyIndex, 'cmakeFiles', 1);
    const toolchainsReference = findObjectReference(replyIndex, 'toolchains', 1);
    const codemodelReference = findObjectReference(replyIndex, 'codemodel', 2);
    const resolveReplyObject = (jsonFile: string): string => {
        return path.resolve(path.dirname(identity.indexFilePath), jsonFile);
    };

    const [cacheObject, cmakeFilesObject, toolchainsObject, codemodelObject] = await Promise.all([
        cacheReference?.jsonFile
            ? tryReadJsonFile<FileApiCacheObject>(resolveReplyObject(cacheReference.jsonFile))
            : Promise.resolve(null),
        cmakeFilesReference?.jsonFile
            ? tryReadJsonFile<FileApiCMakeFilesObject>(resolveReplyObject(cmakeFilesReference.jsonFile))
            : Promise.resolve(null),
        toolchainsReference?.jsonFile
            ? tryReadJsonFile<FileApiToolchainsObject>(resolveReplyObject(toolchainsReference.jsonFile))
            : Promise.resolve(null),
        codemodelReference?.jsonFile
            ? tryReadJsonFile<FileApiCodeModelObject>(resolveReplyObject(codemodelReference.jsonFile))
            : Promise.resolve(null),
    ]);

    const codemodelFilePath = codemodelReference?.jsonFile
        ? resolveReplyObject(codemodelReference.jsonFile)
        : null;
    const targets = codemodelFilePath && codemodelObject
        ? await getTargets(codemodelFilePath, codemodelObject)
        : { byName: {}, byId: {} };
    const sourceRoot = getCacheEntryValue(cacheObject, 'CMAKE_HOME_DIRECTORY')
        ?? getCacheEntryValue(cacheObject, 'CMAKE_SOURCE_DIR');

    return {
        replyDirectory: identity.replyDirectory,
        indexFile: identity.indexFile,
        indexMtimeMs: identity.mtimeMs,
        cacheEntriesByName: getCacheEntriesByName(cacheObject),
        cmakeInputs: getCMakeInputs(cmakeFilesObject),
        globDependencies: getGlobDependencies(cmakeFilesObject),
        toolchainsByLanguage: getToolchainsByLanguage(toolchainsObject),
        targetsByName: targets.byName,
        targetsById: targets.byId,
        buildDirectoriesBySourcePath: getBuildDirectoriesBySourcePath(codemodelObject, sourceRoot, buildDirectory),
    };
}

export async function loadFileApiRawSnapshot(buildDirectory: string): Promise<FileApiRawSnapshot | null> {
    const replyDirectory = getFileApiReplyDirectory(buildDirectory);
    const identity = await getLatestIndexIdentity(replyDirectory);
    if (!identity) {
        return null;
    }

    const identityKey = getIndexIdentityKey(identity);
    const cached = snapshotCacheByIdentity.get(identityKey);
    if (cached) {
        cacheSnapshot(identityKey, cached);
        return cached;
    }

    let load = snapshotLoadsByIdentity.get(identityKey);
    if (!load) {
        load = loadSnapshotForIndex(buildDirectory, identity);
        snapshotLoadsByIdentity.set(identityKey, load);
    }

    try {
        const snapshot = await load;
        cacheSnapshot(identityKey, snapshot);
        return snapshot;
    } finally {
        if (snapshotLoadsByIdentity.get(identityKey) === load) {
            snapshotLoadsByIdentity.delete(identityKey);
        }
    }
}
