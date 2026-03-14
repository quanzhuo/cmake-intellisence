import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { getFileContent } from '../../utils';

suite('Utils Tests', () => {
    test('getFileContent should return empty text for directories', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-'));
        const documents = new TextDocuments(TextDocument);

        try {
            const result = getFileContent(documents, URI.file(tempDir));
            assert.strictEqual(result, '');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFileContent should return empty text for missing paths', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-missing-'));
        const missingPath = path.join(tempDir, '${CMAKE_CURRENT_LIST_DIR}', 'SelectLibraryConfigurations.cmake');
        const documents = new TextDocuments(TextDocument);

        try {
            const result = getFileContent(documents, URI.file(missingPath));
            assert.strictEqual(result, '');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});