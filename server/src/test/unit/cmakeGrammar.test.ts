import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { OnigScanner, OnigString, loadWASM } from 'vscode-oniguruma';
import { IGrammar, INITIAL, Registry, parseRawGrammar } from 'vscode-textmate';

type TokenizedLine = ReturnType<IGrammar['tokenizeLine']>;

suite('CMake TextMate grammar', () => {
    let grammar: IGrammar;

    suiteSetup(async () => {
        const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
        const wasmBuffer = fs.readFileSync(wasmPath);
        const wasm = wasmBuffer.buffer.slice(
            wasmBuffer.byteOffset,
            wasmBuffer.byteOffset + wasmBuffer.byteLength,
        ) as ArrayBuffer;
        await loadWASM(wasm);

        const grammarPath = path.resolve(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            'syntaxes',
            'cmake.tmLanguage.json',
        );
        const registry = new Registry({
            onigLib: Promise.resolve({
                createOnigScanner: patterns => new OnigScanner(patterns),
                createOnigString: text => new OnigString(text),
            }),
            loadGrammar: async scopeName => {
                if (scopeName !== 'source.cmake') {
                    return null;
                }
                return parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath);
            },
        });
        const loadedGrammar = await registry.loadGrammar('source.cmake');
        assert.ok(loadedGrammar);
        grammar = loadedGrammar;
    });

    function tokenize(lines: string[]): TokenizedLine[] {
        const result: TokenizedLine[] = [];
        let ruleStack = INITIAL;
        for (const line of lines) {
            const tokenizedLine = grammar.tokenizeLine(line, ruleStack);
            result.push(tokenizedLine);
            ruleStack = tokenizedLine.ruleStack;
        }
        return result;
    }

    function scopesAtLines(lines: string[], lineIndex: number, text: string, occurrence = 0): string[] {
        const line = lines[lineIndex];
        let offset = -1;
        for (let index = 0; index <= occurrence; index++) {
            offset = line.indexOf(text, offset + 1);
        }
        assert.notStrictEqual(offset, -1, `Expected "${text}" in "${line}"`);

        const token = tokenize(lines)[lineIndex].tokens.find(candidate =>
            candidate.startIndex <= offset
            && candidate.endIndex >= offset + text.length
        );
        assert.ok(token, `Expected a grammar token for "${text}" in "${line}"`);
        return token.scopes;
    }

    function scopesAt(line: string, text: string, occurrence = 0): string[] {
        return scopesAtLines([line], 0, text, occurrence);
    }

    function assertScope(line: string, text: string, expectedScope: string, occurrence = 0): void {
        assert.ok(
            scopesAt(line, text, occurrence).includes(expectedScope),
            `Expected "${text}" in "${line}" to have scope ${expectedScope}`,
        );
    }

    function assertNoScope(line: string, text: string, unexpectedScope: string, occurrence = 0): void {
        assert.ok(
            !scopesAt(line, text, occurrence).includes(unexpectedScope),
            `Expected "${text}" in "${line}" not to have scope ${unexpectedScope}`,
        );
    }

    function assertOutsideStringScope(line: string, text: string, occurrence = 0): void {
        const scopes = scopesAt(line, text, occurrence);
        assert.ok(
            !scopes.some(scope => scope === 'string' || scope.startsWith('string.')),
            `Expected "${text}" in "${line}" not to have a standard string scope, got ${scopes.join(', ')}`,
        );
    }

    test('classifies built-in and custom commands only in invocation position', () => {
        assertScope('message(STATUS "ok")', 'message', 'support.function.cmake');
        assertScope('FetchContent_Declare(example)', 'FetchContent_Declare', 'support.function.cmake');
        assertScope('configure_sdl3_pc()', 'configure_sdl3_pc', 'entity.name.function.cmake');
        assertScope('COMMAND()', 'COMMAND', 'entity.name.function.cmake');

        const argumentLine = 'set(VAR message COMMAND)';
        assertScope(argumentLine, 'set', 'support.function.cmake');
        assertScope(argumentLine, 'VAR', 'variable.other.cmake');
        assertNoScope(argumentLine, 'message', 'support.function.cmake');
        assertNoScope(argumentLine, 'COMMAND', 'keyword.operator.wordlike.cmake');
    });

    test('keeps incomplete commands and unquoted arguments outside string scopes', () => {
        assertOutsideStringScope('configure_sdl3_pc', 'configure_sdl3_pc');
        assertOutsideStringScope('message(payload)', 'payload');
    });

    test('classifies set variables and cache keywords within set commands', () => {
        const line = 'set(MY_VAR value CACHE STRING "doc" FORCE)';
        assertScope(line, 'MY_VAR', 'variable.other.cmake');
        for (const keyword of ['CACHE', 'STRING', 'FORCE']) {
            assertScope(line, keyword, 'keyword.other.cmake');
        }

        const cacheLine = 'set(CACHE{MY_CACHE} TYPE STRING HELP "doc" VALUE value)';
        assertScope(cacheLine, 'CACHE{MY_CACHE}', 'variable.other.cache.cmake');
        for (const keyword of ['TYPE', 'STRING', 'HELP', 'VALUE']) {
            assertScope(cacheLine, keyword, 'keyword.other.cmake');
        }

        assertScope('set(ENV{MY_ENV} value)', 'ENV{MY_ENV}', 'variable.other.environment.cmake');
    });

    test('distinguishes nested normal, environment, and cache variable references', () => {
        const line = 'message("${outer_${inner}} $ENV{PATH} $CACHE{VALUE}")';
        assertScope(line, 'outer_', 'variable.other.cmake');
        assertScope(line, 'inner', 'variable.other.cmake');
        assertScope(line, 'PATH', 'variable.other.environment.cmake');
        assertScope(line, 'VALUE', 'variable.other.cache.cmake');
    });

    test('keeps bracket arguments raw and recognizes escapes in quoted strings', () => {
        const bracketArgument = 'message([=[${not_expanded}]=])';
        assertScope(bracketArgument, 'not_expanded', 'string.quoted.other.cmake');
        assertNoScope(bracketArgument, 'not_expanded', 'variable.other.cmake');

        const quoted = 'message("escaped: \\"; value: ${VALUE}")';
        assertScope(quoted, '\\"', 'constant.character.escape.cmake');
        assertScope(quoted, 'VALUE', 'variable.other.cmake');
    });

    test('preserves multiline bracket comment state until the matching delimiter', () => {
        const lines = [
            '#[=[',
            'message(${NOT_A_REFERENCE})',
            ']=]',
            'message(${REFERENCE})',
        ];
        assert.ok(scopesAtLines(lines, 1, 'NOT_A_REFERENCE').includes('comment.block.bracket.cmake'));
        assert.ok(!scopesAtLines(lines, 1, 'NOT_A_REFERENCE').includes('variable.other.cmake'));
        assert.ok(scopesAtLines(lines, 3, 'REFERENCE').includes('variable.other.cmake'));
    });

    test('recognizes nested generator expressions without classifying operands as functions', () => {
        const line = 'target_link_libraries(app PRIVATE "$<$<CONFIG:Debug>:$<TARGET_FILE:app>>")';
        assertScope(line, 'CONFIG', 'support.function.generator-expression.cmake');
        assertScope(line, 'TARGET_FILE', 'support.function.generator-expression.cmake');
        assertNoScope(line, 'Debug', 'support.function.generator-expression.cmake');
        assertNoScope(line, 'app', 'support.function.generator-expression.cmake', 1);
    });

    test('limits condition operators to condition command arguments', () => {
        const condition = 'if((not exists "${path}") AND value strequal expected)';
        for (const operator of ['not', 'exists', 'AND', 'strequal']) {
            assertScope(condition, operator, 'keyword.operator.wordlike.cmake');
        }

        const plainArguments = 'set(VALUES NOT EXISTS STREQUAL)';
        for (const argument of ['NOT', 'EXISTS', 'STREQUAL']) {
            assertNoScope(plainArguments, argument, 'keyword.operator.wordlike.cmake');
        }
    });

    test('classifies foreach keywords and function declarations contextually', () => {
        const foreachLine = 'foreach(item IN LISTS items)';
        assertScope(foreachLine, 'foreach', 'keyword.control.loop.cmake');
        assertScope(foreachLine, 'IN', 'keyword.other.cmake');
        assertScope(foreachLine, 'LISTS', 'keyword.other.cmake');

        const functionLine = 'function(my_function first second)';
        assertScope(functionLine, 'function', 'keyword.control.command.cmake');
        assertScope(functionLine, 'my_function', 'entity.name.function.cmake');
        assertScope(functionLine, 'first', 'variable.parameter.cmake');
        assertScope(functionLine, 'second', 'variable.parameter.cmake');
    });

    test('segments unquoted arguments around substitutions and escaped characters', () => {
        const line = 'set(VALUE prefix${NAME}suffix foo\\ bar foo\\#bar)';
        assertScope(line, 'NAME', 'variable.other.cmake');
        assertNoScope(line, 'prefix', 'string.unquoted.cmake');
        assertNoScope(line, 'suffix', 'string.unquoted.cmake');
        assertScope(line, '\\ ', 'constant.character.escape.cmake');
        assertScope(line, '\\#', 'constant.character.escape.cmake');
    });

    test('uses conservative numeric matching and standard boolean scopes', () => {
        assertScope('option(FEATURE "Enable" ON)', 'ON', 'constant.language.boolean.cmake');
        assertScope('if(VALUE EQUAL -1.25e+2)', '-1.25e+2', 'constant.numeric.cmake');
        assertNoScope('project(example VERSION 1.2.3)', '1.2.3', 'string.unquoted.cmake');
        assertNoScope('project(example VERSION 1.2.3)', '1.2.3', 'constant.numeric.cmake');
    });
});
