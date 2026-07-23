import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const buildDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(buildDirectory, '..');
const syntaxesDirectory = path.join(repositoryDirectory, 'syntaxes');
const builtinCommandsPath = path.join(repositoryDirectory, 'server', 'src', 'builtin-cmds.json');
const compilerPath = fileURLToPath(import.meta.url);

const grammarFiles = [
    'cmake.tmLanguage.json',
    'cmakecache.tmLanguage.json',
    'cmdsignature.tmLanguage.json',
];

function grammarSourcePath(fileName) {
    return path.join(syntaxesDirectory, fileName.replace(/\.json$/, '.yml'));
}

function grammarOutputPath(fileName) {
    return path.join(syntaxesDirectory, fileName);
}

function isGrammarOutdated(fileName) {
    const outputPath = grammarOutputPath(fileName);
    if (!existsSync(outputPath)) {
        return true;
    }

    const outputTimestamp = statSync(outputPath).mtimeMs;
    const dependencies = [
        grammarSourcePath(fileName),
        compilerPath,
    ];
    if (fileName === 'cmake.tmLanguage.json') {
        dependencies.push(builtinCommandsPath);
    }

    return dependencies.some(dependency => statSync(dependency).mtimeMs > outputTimestamp);
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildBuiltinCommandPattern() {
    const builtinCommands = JSON.parse(readFileSync(builtinCommandsPath, 'utf8'));
    const commandNames = Object.keys(builtinCommands);
    const invalidCommand = commandNames.find(command => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(command));
    if (invalidCommand !== undefined) {
        throw new Error(`Cannot add invalid CMake command to TextMate grammar: ${invalidCommand}`);
    }
    commandNames.sort();

    return `\\b(?i:${commandNames.map(escapeRegex).join('|')})\\b(?=\\s*\\()`;
}

function transformGrammar(grammar, fileName) {
    if (fileName !== 'cmake.tmLanguage.json') {
        return grammar;
    }

    const builtinRule = grammar.repository?.['builtin-command'];
    if (builtinRule?.match !== '__CMAKE_BUILTIN_COMMAND_PATTERN__') {
        throw new Error('CMake grammar is missing the builtin command pattern placeholder');
    }
    builtinRule.match = buildBuiltinCommandPattern();
    return grammar;
}

function compileGrammar(fileName) {
    const sourcePath = grammarSourcePath(fileName);
    const outputPath = grammarOutputPath(fileName);
    const grammar = yaml.load(readFileSync(sourcePath, 'utf8'));
    const transformedGrammar = transformGrammar(grammar, fileName);
    writeFileSync(outputPath, `${JSON.stringify(transformedGrammar, null, 2)}\n`);
}

const requestedFiles = process.argv.slice(2);
const filesToCompile = requestedFiles.length > 0 ? requestedFiles : grammarFiles;

for (const fileName of filesToCompile) {
    if (!grammarFiles.includes(fileName)) {
        throw new Error(`Unknown grammar output: ${fileName}`);
    }
    if (requestedFiles.length > 0 || isGrammarOutdated(fileName)) {
        compileGrammar(fileName);
    }
}
