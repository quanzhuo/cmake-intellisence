import { createHash } from 'crypto';
import { FlatCommand } from './flatCommands';

export interface DependencyStructureAnalysis {
    directFingerprint: string;
    variableFingerprints: ReadonlyMap<string, string>;
    dependencyInputVariables: ReadonlySet<string>;
    variableReferences: ReadonlyMap<string, ReadonlySet<string>>;
}

const LIST_MUTATING_SUBCOMMANDS = new Set([
    'APPEND',
    'FILTER',
    'INSERT',
    'POP_BACK',
    'POP_FRONT',
    'PREPEND',
    'REMOVE_AT',
    'REMOVE_DUPLICATES',
    'REMOVE_ITEM',
    'REVERSE',
    'SORT',
    'TRANSFORM',
]);

function serializeCommand(command: FlatCommand, structuralOrder: number): string {
    return [
        structuralOrder.toString(),
        command.commandName.toLowerCase(),
        ...command.argument_list().map(argument => argument.getText()),
    ].join('\u001f');
}

function getVariableReferences(text: string): string[] {
    return Array.from(text.matchAll(/\$\{([^}]+)\}/g), match => match[1]);
}

function addVariableName(names: Set<string>, text: string | undefined): void {
    if (!text) {
        return;
    }
    names.add(text.includes('${') ? '*' : text);
}

function getListVariableWrites(command: FlatCommand): Set<string> {
    const args = command.argument_list();
    const subcommand = args[0]?.getText().toUpperCase();
    const writes = new Set<string>();
    if (!subcommand) {
        return writes;
    }

    if (LIST_MUTATING_SUBCOMMANDS.has(subcommand)) {
        addVariableName(writes, args[1]?.getText());
    }

    switch (subcommand) {
        case 'FIND':
        case 'JOIN':
            addVariableName(writes, args[3]?.getText());
            break;
        case 'GET':
            addVariableName(writes, args[args.length - 1]?.getText());
            break;
        case 'LENGTH':
            addVariableName(writes, args[2]?.getText());
            break;
        case 'POP_BACK':
        case 'POP_FRONT':
            for (const outputArgument of args.slice(2)) {
                addVariableName(writes, outputArgument.getText());
            }
            break;
        case 'SUBLIST':
            addVariableName(writes, args[4]?.getText());
            break;
        case 'TRANSFORM': {
            const outputVariableIndex = args.findIndex(argument =>
                argument.getText().toUpperCase() === 'OUTPUT_VARIABLE'
            );
            if (outputVariableIndex !== -1) {
                addVariableName(writes, args[outputVariableIndex + 1]?.getText());
            }
            break;
        }
    }
    return writes;
}

function getVariableWrites(command: FlatCommand): Set<string> {
    const commandName = command.commandName.toLowerCase();
    const writes = new Set<string>();
    if (commandName === 'set' || commandName === 'unset') {
        addVariableName(writes, command.argument_list()[0]?.getText());
    } else if (commandName === 'list') {
        return getListVariableWrites(command);
    }
    return writes;
}

function getVariableValueReferences(command: FlatCommand, variableName: string): Set<string> {
    const args = command.argument_list();
    const references = new Set<string>();
    if (command.commandName.toLowerCase() === 'list') {
        const inputVariable = args[1]?.getText();
        if (inputVariable && inputVariable !== variableName && !inputVariable.includes('${')) {
            references.add(inputVariable);
        }
    }
    const referencedArguments = variableName === '*' ? args : args.slice(1);
    for (const argument of referencedArguments) {
        for (const referencedVariable of getVariableReferences(argument.getText())) {
            references.add(referencedVariable);
        }
    }
    return references;
}

function serializeVariableCommand(
    command: FlatCommand,
    dependencyOrder: number,
    references: ReadonlySet<string>,
    variableWriteCounts: ReadonlyMap<string, number>,
): string {
    const referencedVersions = Array.from(references)
        .sort()
        .map(variableName => `${variableName}:${variableWriteCounts.get(variableName) ?? 0}`);
    return [
        serializeCommand(command, dependencyOrder),
        ...referencedVersions,
    ].join('\u001c');
}

export function analyzeDependencyStructure(flatCommands: readonly FlatCommand[]): DependencyStructureAnalysis {
    const directHash = createHash('sha256');
    let directCommandCount = 0;
    const variableCommands = new Map<string, string[]>();
    const variableReferences = new Map<string, Set<string>>();
    const variableWriteCounts = new Map<string, number>();
    const dependencyInputVariables = new Set<string>();

    for (const command of flatCommands) {
        const commandName = command.commandName.toLowerCase();
        const args = command.argument_list();
        const isDirectDependency = commandName === 'include' || commandName === 'add_subdirectory';
        const variableWrites = getVariableWrites(command);
        if (!isDirectDependency && variableWrites.size === 0) {
            continue;
        }
        if (isDirectDependency) {
            const serializedCommand = serializeCommand(command, directCommandCount);
            directCommandCount++;
            directHash.update(serializedCommand);
            directHash.update('\u001d');
            for (const argument of args) {
                for (const variableName of getVariableReferences(argument.getText())) {
                    dependencyInputVariables.add(variableName);
                }
            }
            if (commandName === 'include') {
                dependencyInputVariables.add('CMAKE_MODULE_PATH');
            }
        }

        for (const variableName of variableWrites) {
            const references = getVariableValueReferences(command, variableName);
            // A variable write only needs its position relative to dependency
            // commands and the versions of variables used by its value. Unrelated
            // variable writes must not create false project invalidations.
            const serializedCommand = serializeVariableCommand(
                command,
                directCommandCount,
                references,
                variableWriteCounts,
            );
            const commands = variableCommands.get(variableName) ?? [];
            commands.push(serializedCommand);
            variableCommands.set(variableName, commands);

            if (references.size > 0) {
                const combinedReferences = variableReferences.get(variableName) ?? new Set<string>();
                for (const referencedVariable of references) {
                    combinedReferences.add(referencedVariable);
                }
                variableReferences.set(variableName, combinedReferences);
            }
        }
        for (const variableName of variableWrites) {
            variableWriteCounts.set(variableName, (variableWriteCounts.get(variableName) ?? 0) + 1);
        }
    }

    const pendingInputs = Array.from(dependencyInputVariables);
    for (let index = 0; index < pendingInputs.length; index++) {
        for (const referencedVariable of variableReferences.get(pendingInputs[index]) ?? []) {
            if (!dependencyInputVariables.has(referencedVariable)) {
                dependencyInputVariables.add(referencedVariable);
                pendingInputs.push(referencedVariable);
            }
        }
    }

    const variableFingerprints = new Map<string, string>();
    for (const [variableName, commands] of variableCommands) {
        variableFingerprints.set(
            variableName,
            createHash('sha256').update(commands.join('\u001d')).digest('hex'),
        );
    }

    return {
        directFingerprint: `${directCommandCount}:${directHash.digest('hex')}`,
        variableFingerprints,
        dependencyInputVariables,
        variableReferences,
    };
}
