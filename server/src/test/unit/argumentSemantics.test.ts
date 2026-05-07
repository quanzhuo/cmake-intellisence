import * as assert from 'assert';
import { DefinitionSubject, getArgumentSpanAtPosition, resolveArgumentTarget, resolveCursorTarget } from '../../argumentSemantics';
import { parseCMakeText } from '../../utils';

suite('Argument Semantics Tests', () => {
    test('getArgumentSpanAtPosition should capture the full variable-expanded file path argument', () => {
        const command = parseCMakeText('include(${CMAKE_CURRENT_LIST_DIR}/include/helpers.cmake)\n').flatCommands[0];
        const arg = command.argument_list()[0];
        const position = { line: arg.start.line - 1, character: arg.start.column + 25 };

        const result = getArgumentSpanAtPosition(command, position);
        assert(result !== null);
        assert.strictEqual(result.text, '${CMAKE_CURRENT_LIST_DIR}/include/helpers.cmake');
        assert.strictEqual(result.argumentIndex, 0);
    });

    test('resolveCursorTarget should classify target_include_directories receiver as target', () => {
        const command = parseCMakeText('target_include_directories(app PRIVATE include)\n').flatCommands[0];
        const arg = command.argument_list()[0];
        const position = { line: arg.start.line - 1, character: arg.start.column + 1 };

        const result = resolveCursorTarget(command, 'app', position);
        assert.strictEqual(result.subject, DefinitionSubject.Target);
        assert.strictEqual(result.argumentSpan?.text, 'app');
    });

    test('resolveCursorTarget should classify find_package first argument as find-package', () => {
        const command = parseCMakeText('find_package(Threads REQUIRED)\n').flatCommands[0];
        const arg = command.argument_list()[0];
        const position = { line: arg.start.line - 1, character: arg.start.column + 2 };

        const result = resolveCursorTarget(command, 'Threads', position);
        assert.strictEqual(result.subject, DefinitionSubject.FindPackage);
        assert.strictEqual(result.argumentSpan?.text, 'Threads');
    });

    test('resolveCursorTarget should derive variable text from a full ${VAR} span when word lookup is empty', () => {
        const command = parseCMakeText('message(${ROOT_VAR})\n').flatCommands[0];
        const arg = command.argument_list()[0];
        const position = { line: arg.start.line - 1, character: arg.start.column };

        const result = resolveCursorTarget(command, '', position);
        assert.strictEqual(result.subject, DefinitionSubject.Variable);
        assert.strictEqual(result.text, 'ROOT_VAR');
    });

    test('resolveCursorTarget should preserve full target names with namespace separators', () => {
        const command = parseCMakeText('target_link_libraries(app PRIVATE Qt6::Core)\n').flatCommands[0];
        const arg = command.argument_list()[2];
        const position = { line: arg.start.line - 1, character: arg.start.column + 1 };

        const result = resolveCursorTarget(command, 'Qt6', position);
        assert.strictEqual(result.subject, DefinitionSubject.Target);
        assert.strictEqual(result.text, 'Qt6::Core');
    });

    test('resolveArgumentTarget should classify include module arguments via shared semantics', () => {
        const command = parseCMakeText('include(CMakePrintHelpers)\n').flatCommands[0];

        const result = resolveArgumentTarget(command, 0);
        assert(result !== null);
        assert.strictEqual(result.subject, DefinitionSubject.IncludeModule);
        assert.strictEqual(result.text, 'CMakePrintHelpers');
    });

    test('resolveArgumentTarget should classify add_library source arguments as file paths', () => {
        const command = parseCMakeText('add_library(sample STATIC src/lib.cpp include/lib.h)\n').flatCommands[0];

        const sourceResult = resolveArgumentTarget(command, 2);
        const headerResult = resolveArgumentTarget(command, 3);
        assert.strictEqual(sourceResult?.subject, DefinitionSubject.FilePath);
        assert.strictEqual(sourceResult?.text, 'src/lib.cpp');
        assert.strictEqual(headerResult?.subject, DefinitionSubject.FilePath);
        assert.strictEqual(headerResult?.text, 'include/lib.h');
    });
});