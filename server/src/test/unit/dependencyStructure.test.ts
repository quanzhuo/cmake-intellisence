import * as assert from 'assert';
import { analyzeDependencyStructure } from '../../dependencyStructure';
import { parseCMakeText } from '../../utils';

suite('Dependency Structure Tests', () => {
    test('tracks transitive variables used to resolve dependencies', () => {
        const parsed = parseCMakeText([
            'set(ROOT_DIR ${CMAKE_CURRENT_LIST_DIR})',
            'set(ROUTE_FILE ${ROOT_DIR}/route.cmake)',
            'include(${ROUTE_FILE})',
        ].join('\n'));

        const analysis = analyzeDependencyStructure(parsed.flatCommands);

        assert(analysis.dependencyInputVariables.has('ROUTE_FILE'));
        assert(analysis.dependencyInputVariables.has('ROOT_DIR'));
        assert(analysis.dependencyInputVariables.has('CMAKE_CURRENT_LIST_DIR'));
        assert(analysis.dependencyInputVariables.has('CMAKE_MODULE_PATH'));
    });

    test('tracks list output variables and their input dependencies', () => {
        const parsed = parseCMakeText([
            'set(ROUTE_FILES first.cmake second.cmake)',
            'list(GET ROUTE_FILES 0 ROUTE_FILE)',
            'include(${ROUTE_FILE})',
        ].join('\n'));

        const analysis = analyzeDependencyStructure(parsed.flatCommands);

        assert(analysis.variableFingerprints.has('ROUTE_FILE'));
        assert(analysis.dependencyInputVariables.has('ROUTE_FILE'));
        assert(analysis.dependencyInputVariables.has('ROUTE_FILES'));
    });

    test('marks dynamic variable writes as conservatively affecting every dependency input', () => {
        const beforeTargetName = analyzeDependencyStructure(parseCMakeText([
            'set(VARIABLE_NAME ROUTE_FILE)',
            'set(${VARIABLE_NAME} first.cmake)',
        ].join('\n')).flatCommands);
        const afterTargetName = analyzeDependencyStructure(parseCMakeText([
            'set(${VARIABLE_NAME} first.cmake)',
            'set(VARIABLE_NAME ROUTE_FILE)',
        ].join('\n')).flatCommands);

        assert(beforeTargetName.variableFingerprints.has('*'));
        assert.notStrictEqual(
            beforeTargetName.variableFingerprints.get('*'),
            afterTargetName.variableFingerprints.get('*'),
        );
    });

    test('detects dependency-relevant reordering without coupling unrelated writes', () => {
        const before = analyzeDependencyStructure(parseCMakeText([
            'message(STATUS before)',
            'set(ROUTE_FILE first.cmake)',
            'include(${ROUTE_FILE})',
        ].join('\n')).flatCommands);
        const unrelatedEdit = analyzeDependencyStructure(parseCMakeText([
            'message(STATUS changed)',
            'set(UNRELATED value)',
            'set(ROUTE_FILE first.cmake)',
            'include(${ROUTE_FILE})',
        ].join('\n')).flatCommands);
        const reordered = analyzeDependencyStructure(parseCMakeText([
            'include(${ROUTE_FILE})',
            'set(ROUTE_FILE first.cmake)',
        ].join('\n')).flatCommands);
        const dependenciesInOriginalOrder = analyzeDependencyStructure(parseCMakeText([
            'include(first.cmake)',
            'include(second.cmake)',
        ].join('\n')).flatCommands);
        const dependenciesReordered = analyzeDependencyStructure(parseCMakeText([
            'include(second.cmake)',
            'include(first.cmake)',
        ].join('\n')).flatCommands);
        const referencedWriteBefore = analyzeDependencyStructure(parseCMakeText([
            'set(ROUTE_ROOT first)',
            'set(ROUTE_FILE ${ROUTE_ROOT}.cmake)',
            'include(${ROUTE_FILE})',
        ].join('\n')).flatCommands);
        const referencedWriteAfter = analyzeDependencyStructure(parseCMakeText([
            'set(ROUTE_FILE ${ROUTE_ROOT}.cmake)',
            'set(ROUTE_ROOT first)',
            'include(${ROUTE_FILE})',
        ].join('\n')).flatCommands);

        assert.strictEqual(before.directFingerprint, unrelatedEdit.directFingerprint);
        assert.strictEqual(
            before.variableFingerprints.get('ROUTE_FILE'),
            unrelatedEdit.variableFingerprints.get('ROUTE_FILE'),
        );
        assert.strictEqual(before.directFingerprint, reordered.directFingerprint);
        assert.notStrictEqual(
            before.variableFingerprints.get('ROUTE_FILE'),
            reordered.variableFingerprints.get('ROUTE_FILE'),
        );
        assert.notStrictEqual(
            dependenciesInOriginalOrder.directFingerprint,
            dependenciesReordered.directFingerprint,
        );
        assert.notStrictEqual(
            referencedWriteBefore.variableFingerprints.get('ROUTE_FILE'),
            referencedWriteAfter.variableFingerprints.get('ROUTE_FILE'),
        );
    });
});
