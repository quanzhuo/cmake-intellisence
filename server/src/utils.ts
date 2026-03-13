import { CharStream, CharStreams, CommonTokenStream } from 'antlr4';
import { existsSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI, Utils } from 'vscode-uri';
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

export function getFileContent(documents: TextDocuments<TextDocument>, uri: URI): string {
    const document = documents.get(uri.toString());
    if (document) {
        return document.getText();
    }

    if (existsSync(uri.fsPath) && statSync(uri.fsPath).isDirectory()) {
        return '';
    }

    return readFileSync(uri.fsPath, { encoding: 'utf-8' });
}

export function getIncludeFileUri(symbolIndex: SymbolIndex, baseDir: URI, includeFileName: string): URI | null {
    if (includeFileName.endsWith('/') || includeFileName.endsWith('\\')) {
        return null;
    }

    const incFileUri: URI = Utils.joinPath(baseDir, includeFileName);
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

    const resPath = path.join(symbolIndex.cmakeModulePath ?? '', `${includeFileName}.cmake`);
    if (existsSync(resPath)) {
        return URI.file(resPath);
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
