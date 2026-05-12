export type FileApiCacheEntrySnapshot = {
    name: string;
    type?: string;
    value?: string;
    help?: string;
};

export type FileApiCMakeInputSnapshot = {
    path: string;
    isGenerated?: boolean;
    isExternal?: boolean;
};

export type FileApiToolchainSnapshot = {
    language: string;
    compilerPath?: string;
    compilerId?: string;
    compilerVersion?: string;
    target?: string;
    compilerCommandFragment?: string;
    implicitIncludeDirectories?: string[];
    implicitLinkDirectories?: string[];
    implicitLinkFrameworkDirectories?: string[];
    implicitLinkLibraries?: string[];
    sourceFileExtensions?: string[];
};

export type FileApiTargetSnapshot = {
    id: string;
    name: string;
    type?: string;
    sourcePaths?: string[];
    generatedSourcePaths?: string[];
    includeDirectories?: string[];
    compileDefinitions?: string[];
    artifactPaths?: string[];
    dependencyIds?: string[];
    sourceDirectory?: string;
    buildDirectory?: string;
    folderName?: string;
    nameOnDisk?: string;
    imported?: boolean;
    abstract?: boolean;
    symbolic?: boolean;
    isGeneratorProvided?: boolean;
    backtraceFiles?: string[];
    backtraceCommands?: string[];
    jsonFile?: string;
};

export type FileApiRawSnapshot = {
    replyDirectory: string;
    indexFile: string;
    indexMtimeMs: number;
    cacheEntriesByName: Record<string, FileApiCacheEntrySnapshot>;
    cmakeInputs: FileApiCMakeInputSnapshot[];
    globDependencies: string[];
    toolchainsByLanguage: Record<string, FileApiToolchainSnapshot>;
    targetsByName: Record<string, FileApiTargetSnapshot>;
    targetsById: Record<string, FileApiTargetSnapshot>;
    buildDirectoriesBySourcePath?: Record<string, string>;
};