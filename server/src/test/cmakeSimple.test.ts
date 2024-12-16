import { CharStreams, CommonTokenStream, Token } from 'antlr4';
import * as assert from 'assert';
import CMakeSimpleLexer from '../generated/CMakeSimpleLexer';
import CMakeSimpleParser, { FileContext } from '../generated/CMakeSimpleParser';

suite('CMakeSimpleLexer Tests', () => {
    function parseInput(input: string): [CommonTokenStream, FileContext] {
        const chars = CharStreams.fromString(input);
        const lexer = new CMakeSimpleLexer(chars);
        const tokens = new CommonTokenStream(lexer);
        const parser = new CMakeSimpleParser(tokens);
        const tree = parser.file();
        return [tokens, tree];
    }

    function findTokenWithText(tokens: CommonTokenStream, text: string): Token | null {
        for (let i = 0; i < tokens.tokens.length; i++) {
            const token = tokens.get(i);
            if (token.text === text) {
                return token;
            }
        }
        return null;
    }

    const defaultChannel = CMakeSimpleLexer.channelNames.indexOf('DEFAULT_TOKEN_CHANNEL');
    const hiddenChannel = CMakeSimpleLexer.channelNames.indexOf('HIDDEN');
    const commentsChannel = CMakeSimpleLexer.channelNames.indexOf('COMMENTS');

    test('should parse simple command', () => {
        const input = 'set(VAR value)\n';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].argument_list().length, 2);
    });

    test('newline after the last command is optional', () => {
        const input = 'set(VAR value)';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].argument_list().length, 2);
    });

    test('should parse line comment', () => {
        const input = '# This is a comment';
        const [tokens, tree] = parseInput(input);
        const token = findTokenWithText(tokens, input);
        assert(token !== null);
        assert(token.type === CMakeSimpleLexer.LineComment);
        assert(token.channel === commentsChannel);
    });

    test('should parse bracket comment', () => {
        const input = '#[[This is a bracket comment]]';
        const [tokens, tree] = parseInput(input);
        const token = findTokenWithText(tokens, input);
        assert(token.type === CMakeSimpleLexer.BracketComment);
        assert(token.channel === commentsChannel);
    });

    test('should parse bracket comment with =', () => {
        const input = '#[==[This is a bracket comment ]==]';
        const [tokens, tree] = parseInput(input);
        const token = findTokenWithText(tokens, input);
        assert(token.type === CMakeSimpleLexer.BracketComment);
        assert(token.channel === commentsChannel);
    });

    test('should parse as line comment if with missmatched =', () => {
        const input = '#[==[This is a actually a line comment ]=]';
        const [tokens, tree] = parseInput(input);
        const token = findTokenWithText(tokens, input);
        assert(token !== null);
        assert(token.type === CMakeSimpleLexer.LineComment);
        assert(token.channel === commentsChannel);
    });

    test('should parse bracket comment with nested brackets', () => {
        const input = '#[=[This is a [[nested]] bracket comment ]=]';
        const [tokens, tree] = parseInput(input);
        const token = findTokenWithText(tokens, input);
        assert(token !== null);
        assert(token.type === CMakeSimpleLexer.BracketComment);
        assert(token.channel === commentsChannel);
    });

    test('should parse multi-line bracket comment', () => {
        const input = '#[=[This is a\nmulti-line\nbracket comment]]=]';
        const [tokens, tree] = parseInput(input);
        const token = findTokenWithText(tokens, input);
        assert(token.type === CMakeSimpleLexer.BracketComment);
    });

    test('should parse bracket argument', () => {
        const input = 'set(VAR [=[This is a\nmulti-line\nstring]=])\n';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].argument_list().length, 2);
        const arg0 = commands[0].argument_list()[0];
        const arg1 = commands[0].argument_list()[1];
        assert.strictEqual(arg0.ID().symbol.text, 'VAR');
        assert.strictEqual(arg1.BracketArgument().symbol.type, CMakeSimpleLexer.BracketArgument);

    });

    test('should parse quoted argument with escape sequences', () => {
        const input = 'message("Line1\\nLine2\\tTabbed")\n';
        const [tokens, tree] = parseInput(input);
        const command = tree.command_list()[0];
        const arg0 = command.argument_list()[0];
        assert.strictEqual(arg0.QuotedArgument().symbol.type, CMakeSimpleLexer.QuotedArgument);
        assert.strictEqual(arg0.QuotedArgument().symbol.text, '"Line1\\nLine2\\tTabbed"');
    });

    test('should parse unquoted argument with escape sequences', () => {
        const input = 'set(VAR \\;\\t\\n)\n';
        const [tokens, tree] = parseInput(input);
        const command = tree.command_list()[0];
        const arg1 = command.argument_list()[1];
        assert.strictEqual(arg1.UnquotedArgument().symbol.type, CMakeSimpleLexer.UnquotedArgument);
    });

    test('should parse nested parentheses', () => {
        const input = 'if(EXISTS "${CMAKE_SOURCE_DIR}/config.h")\nadd_definitions(-DHAS_CONFIG)\nendif()';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 3);
        assert.strictEqual(commands[0].argument_list().length, 2);
        assert.strictEqual(commands[1].argument_list().length, 1);
        assert.strictEqual(commands[2].argument_list().length, 0);
    });

    test('should parse complex command arguments', () => {
        const input = 'add_definitions(-DLOG_DIR="${LOG_DIR}")\n';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].argument_list().length, 1);
        const arg0 = commands[0].argument_list()[0];
        assert.strictEqual(arg0.UnquotedArgument().symbol.type, CMakeSimpleLexer.UnquotedArgument);
    });

    test('should parse generator expressions', () => {
        const input = 'target_include_directories(tgt PRIVATE /opt/include/$<CXX_COMPILER_ID>)\n';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 3);
        assert.strictEqual(args[0].ID().symbol.text, 'tgt');
        assert.strictEqual(args[1].ID().symbol.text, 'PRIVATE');
        assert.strictEqual(args[2].UnquotedArgument().symbol.text, '/opt/include/$<CXX_COMPILER_ID>');
    });

    test('should parse multi-line generator expressions', () => {
        const input = 'target_compile_definitions(tgt PRIVATE\n$<$<VERSION_LESS:$<CXX_COMPILER_VERSION>,4.2.0>:OLD_COMPILER>\n)\n';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 3);
        assert.strictEqual(args[0].ID().symbol.text, 'tgt');
        assert.strictEqual(args[1].ID().symbol.text, 'PRIVATE');
        assert.strictEqual(args[2].UnquotedArgument().symbol.text, '$<$<VERSION_LESS:$<CXX_COMPILER_VERSION>,4.2.0>:OLD_COMPILER>');
    });

    test('should parse complex conditional expressions', () => {
        const input = 'if(DEFINED ENV{MY_ENV_VAR} AND "\${MY_VAR}" STREQUAL "value")\nmessage("Condition met")\nendif()\n';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 3);
        const ifCommand = commands[0];
        const messageCommand = commands[1];
        const endifCommand = commands[2];

        assert.strictEqual(ifCommand.argument_list().length, 6);
        assert.strictEqual(ifCommand.argument_list()[0].start.text, 'DEFINED');
        assert.strictEqual(ifCommand.argument_list()[3].start.text, '"${MY_VAR}"');

        assert.strictEqual(messageCommand.argument_list().length, 1);
        assert.strictEqual(messageCommand.argument_list()[0].QuotedArgument().symbol.text, '"Condition met"');

        assert.strictEqual(endifCommand.argument_list().length, 0);
    });

    test('should lex complex input', () => {
        const input = 'set(VAR [=[This is a\nmulti-line\nstring]=])\n';
        const [tokens, tree] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 2);
        assert.strictEqual(args[0].ID().symbol.text, 'VAR');
        assert.strictEqual(args[1].BracketArgument().symbol.type, CMakeSimpleLexer.BracketArgument);
        assert.strictEqual(args[1].BracketArgument().symbol.text, '[=[This is a\nmulti-line\nstring]=]');
    });
});