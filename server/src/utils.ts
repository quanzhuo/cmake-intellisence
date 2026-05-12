import { CharStream, CharStreams, CommonTokenStream } from 'antlr4';
import { existsSync, promises as fsPromises, statSync } from 'fs';
import * as path from 'path';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI, Utils } from 'vscode-uri';
import { FileApiRawSnapshot } from './fileApiSnapshot';
import { FlatCommand, extractFlatCommands } from './flatCommands';
import CMakeLexer from './generated/CMakeLexer';
import CMakeParser, { FileContext } from './generated/CMakeParser';
import { SymbolIndex } from './symbolIndex';

export interface ParsedCMakeFile {
    fileContext: FileContext;
    tokenStream: CommonTokenStream;
    flatCommands: FlatCommand[];
}

export function parseCMakeText(text: string, configureParser?: (parser: CMakeParser) => void): ParsedCMakeFile {
    const input: CharStream = CharStreams.fromString(text);
    const lexer = new CMakeLexer(input);
    const tokenStream = new CommonTokenStream(lexer);
    const parser = new CMakeParser(tokenStream);
    configureParser?.(parser);
    const fileContext = parser.file();
    return {
        fileContext,
        tokenStream,
        flatCommands: extractFlatCommands(fileContext),
    };
}

export function getFileContext(text: string): FileContext {
    return parseCMakeText(text).fileContext;
}

async function readFileContentOrEmpty(uri: URI): Promise<string> {
    try {
        const stats = await fsPromises.stat(uri.fsPath);
        if (stats.isDirectory()) {
            return '';
        }

        return await fsPromises.readFile(uri.fsPath, { encoding: 'utf-8' });
    } catch {
        return '';
    }
}

export async function getFileContent(documents: TextDocuments<TextDocument>, uri: URI): Promise<string> {
    const document = documents.get(uri.toString());
    if (document) {
        return document.getText();
    }

    return readFileContentOrEmpty(uri);
}

export function normalizeQuotedArgument(argText: string): string {
    if ((argText.startsWith('"') && argText.endsWith('"'))
        || (argText.startsWith("'") && argText.endsWith("'"))) {
        return argText.slice(1, -1);
    }

    return argText;
}

export function getIncludeFileUri(symbolIndex: SymbolIndex, baseDir: URI, includeFileName: string): URI | null {
    const normalizedArgText = normalizeQuotedArgument(includeFileName);
    if (normalizedArgText.endsWith('/') || normalizedArgText.endsWith('\\')) {
        return null;
    }

    const normalizedIncludeFileName = normalizedArgText.replace(/\\/g, '/');
    const incFileUri = path.isAbsolute(normalizedArgText)
        ? URI.file(path.normalize(normalizedArgText))
        : Utils.joinPath(baseDir, normalizedIncludeFileName);
    if (existsSync(incFileUri.fsPath)) {
        if (statSync(incFileUri.fsPath).isDirectory()) {
            return null;
        }
        return incFileUri;
    }

    if (symbolIndex.getCache(incFileUri.toString())) {
        return incFileUri;
    }

    // Keep explicit local include targets stable even before they exist on disk.
    if (path.extname(normalizedArgText) !== '' || normalizedArgText.includes('/') || normalizedArgText.includes('\\')) {
        return incFileUri;
    }

    return null;
}

function getIncludeModuleUriFromFileApiSnapshot(fileApiRawSnapshot: FileApiRawSnapshot | undefined, includeFileName: string): URI | null {
    if (!fileApiRawSnapshot) {
        return null;
    }

    const normalizedIncludeFileName = normalizeQuotedArgument(includeFileName);
    const expectedFileName = `${normalizedIncludeFileName}.cmake`.toLowerCase();
    const matchedInput = fileApiRawSnapshot.cmakeInputs.find((input) => {
        return path.isAbsolute(input.path)
            && path.extname(input.path).toLowerCase() === '.cmake'
            && path.basename(input.path).toLowerCase() === expectedFileName;
    });

    return matchedInput ? URI.file(path.normalize(matchedInput.path)) : null;
}

export function getIncludeModuleUri(symbolIndex: SymbolIndex, includeFileName: string, fileApiRawSnapshot?: FileApiRawSnapshot): URI | null {
    const normalizedIncludeFileName = normalizeQuotedArgument(includeFileName);
    if (normalizedIncludeFileName.includes('/') || normalizedIncludeFileName.includes('\\') || path.extname(normalizedIncludeFileName) !== '') {
        return null;
    }

    const resPath = path.join(symbolIndex.cmakeModulePath ?? '', `${normalizedIncludeFileName}.cmake`);
    if (existsSync(resPath)) {
        return URI.file(resPath);
    }

    return getIncludeModuleUriFromFileApiSnapshot(fileApiRawSnapshot, normalizedIncludeFileName);
}

export interface FindPackageUriOptions {
    fileApiRawSnapshot?: FileApiRawSnapshot;
    buildDirectory?: string;
    command?: FlatCommand;
    sourceUri?: URI;
}

function getWorkspaceFolderFsPath(workspaceFolder: string): string {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(workspaceFolder)) {
        return URI.parse(workspaceFolder).fsPath;
    }

    return workspaceFolder;
}

type FindPackageMode = 'module-preferred' | 'module-only' | 'config-only';

function getFindPackageMode(command?: FlatCommand): FindPackageMode {
    if (!command || command.commandName.toLowerCase() !== 'find_package') {
        return 'module-preferred';
    }

    const normalizedArgs = command.argument_list()
        .slice(1)
        .map((arg) => normalizeQuotedArgument(arg.getText()).toUpperCase());

    if (normalizedArgs.includes('MODULE')) {
        return 'module-only';
    }

    if (normalizedArgs.includes('CONFIG') || normalizedArgs.includes('NO_MODULE')) {
        return 'config-only';
    }

    return 'module-preferred';
}

function resolveWorkspaceInputPath(workspaceFolder: string, inputPath: string): string {
    const workspaceFolderFsPath = getWorkspaceFolderFsPath(workspaceFolder);
    return path.isAbsolute(inputPath)
        ? path.normalize(inputPath)
        : path.resolve(workspaceFolderFsPath, inputPath);
}

function findMatchingInputUri(
    fileApiRawSnapshot: FileApiRawSnapshot | undefined,
    workspaceFolder: string,
    matcher: (fileNameLower: string) => boolean,
): URI | null {
    if (!fileApiRawSnapshot) {
        return null;
    }

    for (const input of fileApiRawSnapshot.cmakeInputs) {
        const resolvedPath = resolveWorkspaceInputPath(workspaceFolder, input.path);
        if (path.extname(resolvedPath).toLowerCase() !== '.cmake') {
            continue;
        }

        if (!matcher(path.basename(resolvedPath).toLowerCase())) {
            continue;
        }

        return URI.file(resolvedPath);
    }

    return null;
}

function findPackageInputNames(packageName: string): Set<string> {
    const normalizedPackageName = normalizeQuotedArgument(packageName);
    const lowerPackageName = normalizedPackageName.toLowerCase();
    return new Set([
        `${lowerPackageName}config.cmake`,
        `${lowerPackageName}-config.cmake`,
    ]);
}

function getFindModuleUriFromFileApiSnapshot(
    workspaceFolder: string,
    packageName: string,
    fileApiRawSnapshot?: FileApiRawSnapshot,
): URI | null {
    const expectedFileName = `find${normalizeQuotedArgument(packageName).toLowerCase()}.cmake`;
    return findMatchingInputUri(fileApiRawSnapshot, workspaceFolder, (fileNameLower) => fileNameLower === expectedFileName);
}

function getConfigPackageUriFromFileApiSnapshot(
    workspaceFolder: string,
    packageName: string,
    fileApiRawSnapshot?: FileApiRawSnapshot,
): URI | null {
    const candidateNames = findPackageInputNames(packageName);
    return findMatchingInputUri(fileApiRawSnapshot, workspaceFolder, (fileNameLower) => candidateNames.has(fileNameLower));
}

function getPackageDirFromFileApiSnapshot(fileApiRawSnapshot: FileApiRawSnapshot | undefined, packageName: string): string | null {
    if (!fileApiRawSnapshot) {
        return null;
    }

    const normalizedPackageName = normalizeQuotedArgument(packageName);
    const expectedKey = `${normalizedPackageName}_dir`.toLowerCase();
    const exactMatch = fileApiRawSnapshot.cacheEntriesByName[`${normalizedPackageName}_DIR`];
    if (exactMatch?.value) {
        return exactMatch.value;
    }

    for (const [name, entry] of Object.entries(fileApiRawSnapshot.cacheEntriesByName)) {
        if (name.toLowerCase() === expectedKey && entry.value) {
            return entry.value;
        }
    }

    return null;
}

async function getPackageDirFromCMakeCache(cmakeCacheFile: string, packageName: string): Promise<string | null> {
    let content: string;
    try {
        const cacheStats = await fsPromises.stat(cmakeCacheFile);
        if (!cacheStats.isFile()) {
            return null;
        }

        content = await fsPromises.readFile(cmakeCacheFile, 'utf-8');
    } catch {
        return null;
    }

    const escapedName = normalizeQuotedArgument(packageName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedName}_DIR(?::[^=]+)?=(.*)$`, 'mi');
    const match = content.match(regex);
    return match ? match[1] : null;
}

async function findCaseInsensitiveFileInDirectory(directoryPath: string, matcher: (fileNameLower: string) => boolean): Promise<URI | null> {
    try {
        const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }

            if (!matcher(entry.name.toLowerCase())) {
                continue;
            }

            return URI.file(path.join(directoryPath, entry.name));
        }
    } catch {
        return null;
    }

    return null;
}

async function getConfigPackageUriFromPackageDir(packageDir: string, packageName: string): Promise<URI | null> {
    const candidateNames = findPackageInputNames(packageName);
    const directMatch = await findCaseInsensitiveFileInDirectory(packageDir, (fileNameLower) => candidateNames.has(fileNameLower));
    if (directMatch) {
        return directMatch;
    }

    const normalizedPackageName = normalizeQuotedArgument(packageName);
    const fallbackCandidates = [
        path.join(packageDir, 'lib', 'cmake', normalizedPackageName),
        path.join(packageDir, 'cmake'),
    ];

    for (const candidateDir of fallbackCandidates) {
        const nestedMatch = await findCaseInsensitiveFileInDirectory(candidateDir, (fileNameLower) => candidateNames.has(fileNameLower));
        if (nestedMatch) {
            return nestedMatch;
        }
    }

    return null;
}

function getWorkspaceFindModuleSearchDirs(workspaceFolder: string, sourceUri?: URI): string[] {
    const dirs: string[] = [];
    const workspaceRoot = path.normalize(getWorkspaceFolderFsPath(workspaceFolder));
    const pushIfMissing = (candidate: string) => {
        const normalized = path.normalize(candidate);
        if (!dirs.includes(normalized)) {
            dirs.push(normalized);
        }
    };

    const roots: string[] = [];
    if (sourceUri?.scheme === 'file') {
        let currentDir = path.dirname(sourceUri.fsPath);
        while (true) {
            roots.push(currentDir);
            if (currentDir === workspaceRoot) {
                break;
            }

            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir || !currentDir.startsWith(workspaceRoot)) {
                break;
            }

            currentDir = parentDir;
        }
    }

    if (!roots.includes(workspaceRoot)) {
        roots.push(workspaceRoot);
    }

    for (const root of roots) {
        pushIfMissing(root);
        pushIfMissing(path.join(root, 'Modules'));
    }

    pushIfMissing(path.join(workspaceRoot, 'CMake', 'Modules'));
    pushIfMissing(path.join(workspaceRoot, 'cmake', 'Modules'));
    pushIfMissing(path.join(workspaceRoot, 'cmake', 'modules'));

    return dirs;
}

async function getWorkspaceFindModuleUri(workspaceFolder: string, packageName: string, sourceUri?: URI): Promise<URI | null> {
    const expectedFileName = `find${normalizeQuotedArgument(packageName).toLowerCase()}.cmake`;
    const searchDirs = getWorkspaceFindModuleSearchDirs(workspaceFolder, sourceUri);

    for (const directoryPath of searchDirs) {
        const match = await findCaseInsensitiveFileInDirectory(directoryPath, (fileNameLower) => fileNameLower === expectedFileName);
        if (match) {
            return match;
        }
    }

    return null;
}

async function resolveFindModuleUri(
    symbolIndex: SymbolIndex,
    workspaceFolder: string,
    packageName: string,
    fileApiRawSnapshot?: FileApiRawSnapshot,
    sourceUri?: URI,
): Promise<URI | null> {
    const builtinModuleUri = getIncludeModuleUri(symbolIndex, `Find${normalizeQuotedArgument(packageName)}`);
    if (builtinModuleUri) {
        return builtinModuleUri;
    }

    const workspaceModuleUri = await getWorkspaceFindModuleUri(workspaceFolder, packageName, sourceUri);
    if (workspaceModuleUri) {
        return workspaceModuleUri;
    }

    return getFindModuleUriFromFileApiSnapshot(workspaceFolder, packageName, fileApiRawSnapshot);
}

async function resolveConfigPackageUri(
    workspaceFolder: string,
    packageName: string,
    fileApiRawSnapshot?: FileApiRawSnapshot,
    buildDirectory?: string,
): Promise<URI | null> {
    const directInputUri = getConfigPackageUriFromFileApiSnapshot(workspaceFolder, packageName, fileApiRawSnapshot);
    if (directInputUri) {
        return directInputUri;
    }

    let packageDir = getPackageDirFromFileApiSnapshot(fileApiRawSnapshot, packageName);
    if (!packageDir) {
        const workspaceFolderFsPath = getWorkspaceFolderFsPath(workspaceFolder);
        packageDir = await getPackageDirFromCMakeCache(path.join(buildDirectory ?? path.join(workspaceFolderFsPath, 'build'), 'CMakeCache.txt'), packageName);
    }

    if (!packageDir) {
        return null;
    }

    return getConfigPackageUriFromPackageDir(packageDir, packageName);
}

export async function getFindPackageUri(
    symbolIndex: SymbolIndex,
    workspaceFolder: string,
    packageName: string,
    options: FindPackageUriOptions = {},
): Promise<URI | null> {
    const mode = getFindPackageMode(options.command);

    if (mode !== 'config-only') {
        const moduleUri = await resolveFindModuleUri(
            symbolIndex,
            workspaceFolder,
            packageName,
            options.fileApiRawSnapshot,
            options.sourceUri,
        );
        if (moduleUri) {
            return moduleUri;
        }
    }

    if (mode !== 'module-only') {
        const configUri = await resolveConfigPackageUri(
            workspaceFolder,
            packageName,
            options.fileApiRawSnapshot,
            options.buildDirectory,
        );
        if (configUri) {
            return configUri;
        }
    }

    return null;
}

export function getCmdKeyWords(sigs: string[]): string[] {
    const keywords = new Set<string>();
    sigs.forEach(sig => {
        (sig.match(/[@A-Z0-9][A-Z_0-9]*[A-Z0-9]/g) ?? []).forEach(keyword => keywords.add(keyword));
    });
    return Array.from(keywords);
}
