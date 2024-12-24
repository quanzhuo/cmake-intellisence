import { CharStream, CharStreams, CommonTokenStream } from 'antlr4';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI, Utils } from 'vscode-uri';
import { CMakeInfo } from './cmakeInfo';
import CMakeLexer from './generated/CMakeLexer';
import CMakeParser, { FileContext } from './generated/CMakeParser';
import CMakeSimpleLexer from './generated/CMakeSimpleLexer';
import CMakeSimpleParser, * as cmsp from './generated/CMakeSimpleParser';

export function getSimpleFileContext(text: string): cmsp.FileContext {
    const input: CharStream = CharStreams.fromString(text);
    const lexer = new CMakeSimpleLexer(input);
    const tokenStream = new CommonTokenStream(lexer);
    const parser = new CMakeSimpleParser(tokenStream);
    return parser.file();
}

export function getFileContext(text: string): FileContext {
    const input: CharStream = CharStreams.fromString(text);
    const lexer = new CMakeLexer(input);
    const tokenStream = new CommonTokenStream(lexer);
    const parser = new CMakeParser(tokenStream);
    return parser.file();
}

export function getFileContent(documents: TextDocuments<TextDocument>, uri: URI): string {
    const document = documents.get(uri.toString());
    if (document) {
        return document.getText();
    } else {
        return readFileSync(uri.fsPath, { encoding: 'utf-8' });
    }
}

export function getIncludeFileUri(cmakeInfo: CMakeInfo, baseDir: URI, includeFileName: string): URI | null {
    const incFileUri: URI = Utils.joinPath(baseDir, includeFileName);
    if (existsSync(incFileUri.fsPath)) {
        return incFileUri;
    }

    const resPath = path.join(cmakeInfo.cmakeModulePath, `${includeFileName}.cmake`);
    if (existsSync(resPath)) {
        return URI.file(resPath);
    }

    return null;
}

export function getCmdKeyWords(sigs: string[]): string[] {
    const keywords = new Set<string>();
    sigs.forEach(sig => {
        (sig.match(/[A-Z0-9][A-Z_0-9]*[A-Z0-9]/g) ?? []).forEach(keyword => keywords.add(keyword));
    });
    return Array.from(keywords);
}
