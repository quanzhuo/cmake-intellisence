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

export function getIncludeFileUri(symbolIndex: SymbolIndex, baseDir: URI, includeFileName: string): URI | null {
    if (includeFileName.endsWith('/') || includeFileName.endsWith('\\')) {
        return null;
    }

    const normalizedIncludeFileName = includeFileName.replace(/\\/g, '/');
    const incFileUri = path.isAbsolute(includeFileName)
        ? URI.file(path.normalize(includeFileName))
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
    if (path.extname(includeFileName) !== '' || includeFileName.includes('/') || includeFileName.includes('\\')) {
        return incFileUri;
    }

    return null;
}

function getIncludeModuleUriFromFileApiSnapshot(fileApiRawSnapshot: FileApiRawSnapshot | undefined, includeFileName: string): URI | null {
    if (!fileApiRawSnapshot) {
        return null;
    }

    const expectedFileName = `${includeFileName}.cmake`.toLowerCase();
    const matchedInput = fileApiRawSnapshot.cmakeInputs.find((input) => {
        return path.isAbsolute(input.path)
            && path.extname(input.path).toLowerCase() === '.cmake'
            && path.basename(input.path).toLowerCase() === expectedFileName;
    });

    return matchedInput ? URI.file(path.normalize(matchedInput.path)) : null;
}

export function getIncludeModuleUri(symbolIndex: SymbolIndex, includeFileName: string, fileApiRawSnapshot?: FileApiRawSnapshot): URI | null {
    if (includeFileName.includes('/') || includeFileName.includes('\\') || path.extname(includeFileName) !== '') {
        return null;
    }

    const resPath = path.join(symbolIndex.cmakeModulePath ?? '', `${includeFileName}.cmake`);
    if (existsSync(resPath)) {
        return URI.file(resPath);
    }

    return getIncludeModuleUriFromFileApiSnapshot(fileApiRawSnapshot, includeFileName);
}

function getPackageDirFromFileApiSnapshot(fileApiRawSnapshot: FileApiRawSnapshot | undefined, packageName: string): string | null {
    if (!fileApiRawSnapshot) {
        return null;
    }

    const cacheEntry = fileApiRawSnapshot.cacheEntriesByName[`${packageName}_DIR`];
    if (!cacheEntry?.value) {
        return null;
    }

    return cacheEntry.value;
}

export async function getFindPackageUri(
    symbolIndex: SymbolIndex,
    workspaceFolder: string,
    packageName: string,
    fileApiRawSnapshot?: FileApiRawSnapshot,
    buildDirectory?: string,
): Promise<URI | null> {
    const findModuleUri = getIncludeModuleUri(symbolIndex, `Find${packageName}`, fileApiRawSnapshot);
    if (findModuleUri) {
        return findModuleUri;
    }

    let packageDir = getPackageDirFromFileApiSnapshot(fileApiRawSnapshot, packageName);
    if (!packageDir) {
        const cmakeCacheFile = path.join(buildDirectory ?? path.join(workspaceFolder, 'build'), 'CMakeCache.txt');
        try {
            const cacheStats = await fsPromises.stat(cmakeCacheFile);
            if (!cacheStats.isFile()) {
                return null;
            }
        } catch {
            return null;
        }

        const content = await fsPromises.readFile(cmakeCacheFile, 'utf-8');
        const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^${escapedName}_DIR:PATH=(.*)$`, 'm');
        const match = content.match(regex);
        packageDir = match ? match[1] : null;
    }

    if (!packageDir) {
        return null;
    }

    const alternatives = [
        path.join(packageDir, 'lib', 'cmake', packageName, `${packageName}Config.cmake`),
        path.join(packageDir, 'lib', 'cmake', packageName, `${packageName.toLowerCase()}-config.cmake`),
        path.join(packageDir, `${packageName}Config.cmake`),
        path.join(packageDir, `${packageName.toLowerCase()}-config.cmake`),
    ];

    for (const candidate of alternatives) {
        try {
            const stats = await fsPromises.stat(candidate);
            if (!stats.isFile()) {
                continue;
            }

            return URI.file(candidate);
        } catch {
            continue;
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
