import * as assert from 'assert';
import { ArgumentSemanticKind, DefinitionSubject, getArgumentSemanticKinds, getArgumentSpanAtPosition, getTargetLinkLibraryKeywords, resolveArgumentTarget, resolveCursorTarget } from '../../argumentSemantics';
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

    test('getArgumentSpanAtPosition should locate positions inside multiline arguments', () => {
        const command = parseCMakeText('message("before\n${VALUE}\nafter")\n').flatCommands[0];
        const result = getArgumentSpanAtPosition(command, { line: 1, character: 4 });

        assert(result !== null);
        assert.strictEqual(result.argumentIndex, 0);
        assert.strictEqual(result.start.line, 0);
        assert.strictEqual(result.end.line, 2);
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

    test('resolveCursorTarget should normalize quoted include module and find_package arguments', () => {
        const includeCommand = parseCMakeText('include("CMakePrintHelpers")\n').flatCommands[0];
        const includeArg = includeCommand.argument_list()[0];
        const includePosition = { line: includeArg.start.line - 1, character: includeArg.start.column + 2 };
        const includeResult = resolveCursorTarget(includeCommand, '', includePosition);

        assert.strictEqual(includeResult.subject, DefinitionSubject.IncludeModule);
        assert.strictEqual(includeResult.text, 'CMakePrintHelpers');

        const packageCommand = parseCMakeText('find_package("Threads" REQUIRED)\n').flatCommands[0];
        const packageArg = packageCommand.argument_list()[0];
        const packagePosition = { line: packageArg.start.line - 1, character: packageArg.start.column + 2 };
        const packageResult = resolveCursorTarget(packageCommand, '', packagePosition);

        assert.strictEqual(packageResult.subject, DefinitionSubject.FindPackage);
        assert.strictEqual(packageResult.text, 'Threads');
    });

    test('resolveCursorTarget should derive variable text from a full ${VAR} span when word lookup is empty', () => {
        const command = parseCMakeText('message(${ROOT_VAR})\n').flatCommands[0];
        const arg = command.argument_list()[0];
        const position = { line: arg.start.line - 1, character: arg.start.column };

        const result = resolveCursorTarget(command, '', position);
        assert.strictEqual(result.subject, DefinitionSubject.Variable);
        assert.strictEqual(result.text, 'ROOT_VAR');
    });

    test('resolveCursorTarget should derive variable text from a mixed argument when word lookup is empty', () => {
        const command = parseCMakeText('message(prefix_${ROOT_VAR}_suffix)\n').flatCommands[0];
        const arg = command.argument_list()[0];
        const position = { line: arg.start.line - 1, character: arg.start.column + 11 };

        const result = resolveCursorTarget(command, '', position);
        assert.strictEqual(result.subject, DefinitionSubject.Variable);
        assert.strictEqual(result.text, 'ROOT_VAR');
    });

    test('shared target semantics should cover declarations, aliases, dependencies, and property commands', () => {
        const cases: Array<[string, number]> = [
            ['add_custom_target(generate)', 0],
            ['add_library(alias ALIAS core)', 2],
            ['add_dependencies(app generate core)', 2],
            ['add_custom_command(TARGET app POST_BUILD COMMAND echo)', 1],
            ['set_target_properties(app core PROPERTIES OUTPUT_NAME sample)', 1],
            ['set_property(TARGET app core PROPERTY POSITION_INDEPENDENT_CODE ON)', 2],
            ['get_property(out TARGET app PROPERTY TYPE)', 2],
            ['install(TARGETS app core RUNTIME DESTINATION bin)', 2],
            ['export(TARGETS app core FILE targets.cmake)', 2],
        ];

        for (const [source, argumentIndex] of cases) {
            const command = parseCMakeText(`${source}\n`).flatCommands[0];
            assert(
                getArgumentSemanticKinds(command, argumentIndex).has(ArgumentSemanticKind.Target),
                `${source} argument ${argumentIndex} should be a target`,
            );
        }
    });

    test('resolveCursorTarget should prefer an embedded variable over the surrounding target argument', () => {
        const command = parseCMakeText('target_link_libraries(app PRIVATE ${LIB_TARGET})\n').flatCommands[0];
        const arg = command.argument_list()[2];
        const position = { line: arg.start.line - 1, character: arg.start.column + 4 };

        const result = resolveCursorTarget(command, '', position);
        assert.strictEqual(result.subject, DefinitionSubject.Variable);
        assert.strictEqual(result.text, 'LIB_TARGET');
    });

    test('resolveCursorTarget should preserve full target names with namespace separators', () => {
        const command = parseCMakeText('target_link_libraries(app PRIVATE Qt6::Core)\n').flatCommands[0];
        const arg = command.argument_list()[2];
        const position = { line: arg.start.line - 1, character: arg.start.column + 1 };

        const result = resolveCursorTarget(command, 'Qt6', position);
        assert.strictEqual(result.subject, DefinitionSubject.Target);
        assert.strictEqual(result.text, 'Qt6::Core');
    });

    test('resolveCursorTarget should classify TARGET_FILE generator-expression operands as targets', () => {
        const command = parseCMakeText('target_compile_definitions(app PRIVATE $<TARGET_FILE:core>)\n').flatCommands[0];
        const arg = command.argument_list()[2];
        const position = { line: arg.start.line - 1, character: arg.start.column + arg.getText().indexOf('core') + 1 };

        const result = resolveCursorTarget(command, '', position);
        assert.strictEqual(result.subject, DefinitionSubject.Target);
        assert.strictEqual(result.text, 'core');
    });

    test('resolveCursorTarget should classify TARGET_PROPERTY generator-expression target operands as targets', () => {
        const command = parseCMakeText('target_compile_definitions(app PRIVATE $<TARGET_PROPERTY:core,INTERFACE_INCLUDE_DIRECTORIES>)\n').flatCommands[0];
        const arg = command.argument_list()[2];
        const position = { line: arg.start.line - 1, character: arg.start.column + arg.getText().indexOf('core') + 1 };

        const result = resolveCursorTarget(command, '', position);
        assert.strictEqual(result.subject, DefinitionSubject.Target);
        assert.strictEqual(result.text, 'core');
    });

    test('target arguments should resolve embedded generator-expression targets instead of the whole expression', () => {
        const command = parseCMakeText('target_link_libraries(app PRIVATE $<TARGET_NAME_IF_EXISTS:core>)\n').flatCommands[0];
        const arg = command.argument_list()[2];
        const position = { line: arg.start.line - 1, character: arg.start.column + arg.getText().indexOf('core') + 1 };

        const result = resolveCursorTarget(command, '', position);
        assert.strictEqual(result.subject, DefinitionSubject.Target);
        assert.strictEqual(result.text, 'core');
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

    test('resolveArgumentTarget should classify direct target_sources entries as file paths', () => {
        const command = parseCMakeText('target_sources(sample PRIVATE src/lib.cpp include/lib.h)\n').flatCommands[0];

        const sourceResult = resolveArgumentTarget(command, 2);
        const headerResult = resolveArgumentTarget(command, 3);
        assert.strictEqual(sourceResult?.subject, DefinitionSubject.FilePath);
        assert.strictEqual(sourceResult?.text, 'src/lib.cpp');
        assert.strictEqual(headerResult?.subject, DefinitionSubject.FilePath);
        assert.strictEqual(headerResult?.text, 'include/lib.h');
    });

    test('target_sources FILE_SET metadata should not be classified as file paths', () => {
        const command = parseCMakeText('target_sources(sample PRIVATE FILE_SET HEADERS TYPE HEADERS BASE_DIRS include/api FILES include/api/lib.h)\n').flatCommands[0];

        assert.strictEqual(resolveArgumentTarget(command, 3)?.subject, DefinitionSubject.Variable);
        assert.strictEqual(resolveArgumentTarget(command, 5)?.subject, DefinitionSubject.Variable);
        assert.strictEqual(resolveArgumentTarget(command, 7)?.subject, DefinitionSubject.Variable);
        assert.strictEqual(resolveArgumentTarget(command, 9)?.subject, DefinitionSubject.FilePath);
        assert.strictEqual(resolveArgumentTarget(command, 9)?.text, 'include/api/lib.h');
    });

    test('getTargetLinkLibraryKeywords should expose the shared target_link_libraries keywords', () => {
        const keywords = getTargetLinkLibraryKeywords();

        assert(keywords.includes('PRIVATE'));
        assert(keywords.includes('INTERFACE'));
        assert(keywords.includes('LINK_PUBLIC'));
    });

    test('getArgumentSemanticKinds should expose both include-module and file-path semantics for include()', () => {
        const command = parseCMakeText('include(helper.cmake)\n').flatCommands[0];

        const kinds = getArgumentSemanticKinds(command, 0);
        assert(kinds.has(ArgumentSemanticKind.IncludeModule));
        assert(kinds.has(ArgumentSemanticKind.FilePath));
    });

    test('getArgumentSemanticKinds should expose find-package semantics for find_package()', () => {
        const command = parseCMakeText('find_package(Threads REQUIRED)\n').flatCommands[0];

        const kinds = getArgumentSemanticKinds(command, 0);
        assert(kinds.has(ArgumentSemanticKind.FindPackage));
        assert(!kinds.has(ArgumentSemanticKind.FilePath));
    });

    test('getArgumentSemanticKinds should expose find-package semantics for an empty find_package slot', () => {
        const command = parseCMakeText('find_package()\n').flatCommands[0];

        const kinds = getArgumentSemanticKinds(command, 0);
        assert(kinds.has(ArgumentSemanticKind.FindPackage));
        assert(!kinds.has(ArgumentSemanticKind.FilePath));
    });

    test('getArgumentSemanticKinds should expose file-path semantics for configure_file input/output', () => {
        const command = parseCMakeText('configure_file(config/input.in config/output.txt)\n').flatCommands[0];

        assert(getArgumentSemanticKinds(command, 0).has(ArgumentSemanticKind.FilePath));
        assert(getArgumentSemanticKinds(command, 1).has(ArgumentSemanticKind.FilePath));
    });

    test('getArgumentSemanticKinds should expose file-path semantics only for target_sources direct sources and FILES payload', () => {
        const command = parseCMakeText('target_sources(sample PRIVATE src/lib.cpp FILE_SET HEADERS TYPE HEADERS BASE_DIRS include/api FILES include/api/lib.h)\n').flatCommands[0];

        assert(getArgumentSemanticKinds(command, 2).has(ArgumentSemanticKind.FilePath));
        assert(!getArgumentSemanticKinds(command, 4).has(ArgumentSemanticKind.FilePath));
        assert(!getArgumentSemanticKinds(command, 6).has(ArgumentSemanticKind.FilePath));
        assert(!getArgumentSemanticKinds(command, 8).has(ArgumentSemanticKind.FilePath));
        assert(getArgumentSemanticKinds(command, 10).has(ArgumentSemanticKind.FilePath));
    });

    test('getArgumentSemanticKinds should expose property semantics for set_target_properties values after PROPERTIES', () => {
        const command = parseCMakeText('set_target_properties(my_target PROPERTIES POSITION_INDEPENDENT_CODE ON)\n').flatCommands[0];

        assert(getArgumentSemanticKinds(command, 2).has(ArgumentSemanticKind.Property));
        assert(!getArgumentSemanticKinds(command, 3).has(ArgumentSemanticKind.Property));
    });

    test('getArgumentSemanticKinds should expose property semantics for get_target_property LOCATION property slot', () => {
        const command = parseCMakeText('get_target_property(out my_target LOCATION)\n').flatCommands[0];

        assert(getArgumentSemanticKinds(command, 2).has(ArgumentSemanticKind.Property));
    });
});
