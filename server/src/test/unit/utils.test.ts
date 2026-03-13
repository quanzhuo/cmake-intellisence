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
});