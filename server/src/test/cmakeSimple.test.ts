import { CharStreams, CommonTokenStream, ErrorListener, Token } from 'antlr4';
import * as assert from 'assert';
import CMakeSimpleLexer from '../generated/CMakeSimpleLexer';
import CMakeSimpleParser, { FileContext } from '../generated/CMakeSimpleParser';

export class SyntaxErrorListener extends ErrorListener<string> {
    private _errors = 0;

    syntaxError(recognizer, offendingSymbol, line, column, msg, e) {
        this._errors++;
    }

    get errorCount() {
        return this._errors;
    }
}

suite('CMakeSimple Tests', () => {

    function parseInput(input: string): [CommonTokenStream, FileContext, number] {
        const chars = CharStreams.fromString(input);
        const lexer = new CMakeSimpleLexer(chars);
        const tokens = new CommonTokenStream(lexer);
        const parser = new CMakeSimpleParser(tokens);
        parser.removeErrorListeners();
        const syntaxErrorListener = new SyntaxErrorListener();
        parser.addErrorListener(syntaxErrorListener);
        const tree = parser.file();
        return [tokens, tree, syntaxErrorListener.errorCount];
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
        const [_, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].argument_list().length, 2);
        assert.strictEqual(errs, 0);
    });

    test('newline after the last command is optional', () => {
        const input = 'set(VAR value)';
        const [_, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].argument_list().length, 2);
        assert.strictEqual(errs, 0);
    });

    test('comment test', () => {
        const inputs = [
            '# This is a comment',
            '#[[This is a bracket comment]]',
            '#[==[This is a bracket comment ]==]',
            '#[==[This is a actually a line comment ]=]',
            '#[=[This is a [[nested]] bracket comment ]=]',
            '#[=[This is a\nmulti-line\nbracket comment]]=]',
        ];

        for (const input of inputs) {
            const [tokens, _, errs] = parseInput(input);
            const token = tokens.tokens[0];
            assert.strictEqual(token.channel, commentsChannel);
            assert.strictEqual(errs, 0);
        }
    });

    test('should parse bracket argument', () => {
        const input = 'set(VAR [=[This is a\nmulti-line\nstring]=])\n';
        const [_, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].argument_list().length, 2);
        const arg0 = commands[0].argument_list()[0];
        const arg1 = commands[0].argument_list()[1];
        assert.strictEqual(arg0.ID().symbol.text, 'VAR');
        assert.strictEqual(arg1.BracketArgument().symbol.type, CMakeSimpleLexer.BracketArgument);
        assert.strictEqual(errs, 0);
    });

    test('should parse quoted argument with escape sequences', () => {
        const input = 'message("Line1\\nLine2\\tTabbed")\n';
        const [tokens, tree, errs] = parseInput(input);
        const command = tree.command_list()[0];
        const arg0 = command.argument_list()[0];
        assert.strictEqual(arg0.QuotedArgument().symbol.type, CMakeSimpleLexer.QuotedArgument);
        assert.strictEqual(arg0.QuotedArgument().symbol.text, '"Line1\\nLine2\\tTabbed"');
        assert.strictEqual(errs, 0);
    });

    test('should parse unquoted argument with escape sequences', () => {
        const input = 'set(VAR \\;\\t\\n)\n';
        const [tokens, tree, errs] = parseInput(input);
        const command = tree.command_list()[0];
        const arg1 = command.argument_list()[1];
        assert.strictEqual(arg1.UnquotedArgument().symbol.type, CMakeSimpleLexer.UnquotedArgument);
        assert.strictEqual(errs, 0);
    });

    test('should parse nested parentheses', () => {
        const input = 'if(EXISTS "${CMAKE_SOURCE_DIR}/config.h")\nadd_definitions(-DHAS_CONFIG)\nendif()';
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 3);
        assert.strictEqual(commands[0].argument_list().length, 2);
        assert.strictEqual(commands[1].argument_list().length, 1);
        assert.strictEqual(commands[2].argument_list().length, 0);
        assert.strictEqual(errs, 0);
    });

    test('should parse complex command arguments', () => {
        const input = 'add_definitions(-DLOG_DIR="${LOG_DIR}")\n';
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].argument_list().length, 1);
        const arg0 = commands[0].argument_list()[0];
        assert.strictEqual(arg0.UnquotedArgument().symbol.type, CMakeSimpleLexer.UnquotedArgument);
        assert.strictEqual(errs, 0);
    });

    test('should parse generator expressions', () => {
        const input = 'target_include_directories(tgt PRIVATE /opt/include/$<CXX_COMPILER_ID>)\n';
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 3);
        assert.strictEqual(args[0].ID().symbol.text, 'tgt');
        assert.strictEqual(args[1].ID().symbol.text, 'PRIVATE');
        assert.strictEqual(args[2].UnquotedArgument().symbol.text, '/opt/include/$<CXX_COMPILER_ID>');
        assert.strictEqual(errs, 0);
    });

    test('should parse multi-line generator expressions', () => {
        const input = 'target_compile_definitions(tgt PRIVATE\n$<$<VERSION_LESS:$<CXX_COMPILER_VERSION>,4.2.0>:OLD_COMPILER>\n)\n';
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 3);
        assert.strictEqual(args[0].ID().symbol.text, 'tgt');
        assert.strictEqual(args[1].ID().symbol.text, 'PRIVATE');
        assert.strictEqual(args[2].UnquotedArgument().symbol.text, '$<$<VERSION_LESS:$<CXX_COMPILER_VERSION>,4.2.0>:OLD_COMPILER>');
        assert.strictEqual(errs, 0);
    });

    test('should parse complex conditional expressions', () => {
        const input = 'if(DEFINED ENV{MY_ENV_VAR} AND "\${MY_VAR}" STREQUAL "value")\nmessage("Condition met")\nendif()\n';
        const [tokens, tree, errs] = parseInput(input);
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
        assert.strictEqual(errs, 0);
    });

    test('should lex complex input', () => {
        const input = 'set(VAR [=[This is a\nmulti-line\nstring]=])\n';
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 2);
        assert.strictEqual(args[0].ID().symbol.text, 'VAR');
        assert.strictEqual(args[1].BracketArgument().symbol.type, CMakeSimpleLexer.BracketArgument);
        assert.strictEqual(args[1].BracketArgument().symbol.text, '[=[This is a\nmulti-line\nstring]=]');
        assert.strictEqual(errs, 0);
    });

    test('should parse separated arguments', () => {
        const input = 'if(FALSE AND (FALSE OR TRUE))';
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 3);
        assert.strictEqual(errs, 0);
    });

    test('command name should be case-insensitive', () => {

    });

    test('bracket argument example from cmake language tutorial', () => {
        const input = `
message([=[
This is the first line in a bracket argument with bracket length 1.
No \-escape sequences or \${variable} references are evaluated.
This is always one argument even though it contains a ; character.
The text does not end on a closing bracket of length 0 like ]].
It does end in a closing bracket of length 1.
]=])`;
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 1);
        assert.strictEqual(args[0].BracketArgument().symbol.type, CMakeSimpleLexer.BracketArgument);
        assert.strictEqual(errs, 0);
    });

    test('quoted argument example from cmake language tutorial', () => {
        const input = `
set(TEXT "This is a quoted argument containing multiple lines.
This is always one argument even though it contains a ; character.
Both \\-escape sequences and \${variable} references are evaluated.
The text does not end on an escaped double-quote like \\\".
It does end in an unescaped double quote.
")
`;
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 2);
        assert.strictEqual(args[1].QuotedArgument().symbol.type, CMakeSimpleLexer.QuotedArgument);
        assert.strictEqual(errs, 0);
    });

    test('unquoted argument example from cmake language tutorial', () => {
        const input = String.raw`
foreach(arg
    NoSpace
    Escaped\ Space
    This;Divides;Into;Five;Arguments
    Escaped\;Semicolon
    )
  message("\${arg}")
endforeach()`;
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 3);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 5);
        assert.strictEqual(args[0].ID().symbol.type, CMakeSimpleLexer.ID);
        assert.strictEqual(args[1].ID().symbol.text, 'NoSpace');
        assert.strictEqual(args[2].UnquotedArgument().symbol.type, CMakeSimpleLexer.UnquotedArgument);
        assert.strictEqual(args[2].UnquotedArgument().symbol.text, String.raw`Escaped\ Space`);
        assert.strictEqual(args[3].UnquotedArgument().symbol.type, CMakeSimpleLexer.UnquotedArgument);
        assert.strictEqual(args[3].UnquotedArgument().symbol.text, 'This;Divides;Into;Five;Arguments');
        assert.strictEqual(args[4].UnquotedArgument().symbol.type, CMakeSimpleLexer.UnquotedArgument);
        assert.strictEqual(args[4].UnquotedArgument().symbol.text, String.raw`Escaped\;Semicolon`);
        assert.strictEqual(errs, 0);
    });

    test('bracket comment example from cmake language tutorial', () => {
        const input = `
#[[This is a bracket comment.
It runs until the close bracket.]]
message("First Argument\n" #[[Bracket Comment]] "Second Argument")
`;
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        const bracketComment1 = findTokenWithText(tokens, `#[[This is a bracket comment.
It runs until the close bracket.]]`);
        assert(bracketComment1 !== null);
        assert.strictEqual(bracketComment1.type, CMakeSimpleLexer.Comment);
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 2);
        const bracketComment2 = findTokenWithText(tokens, `#[[Bracket Comment]]`);
        assert(bracketComment2 !== null);
        assert.strictEqual(bracketComment2.type, CMakeSimpleLexer.Comment);
        assert.strictEqual(errs, 0);
    });

    test('line comment example from cmake language tutorial', () => {
        const input = `
# This is a line comment1.
message("First Argument\n" # This is a line comment :)
        "Second Argument") # This is a line comment2.
`;
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        const lineComment1 = findTokenWithText(tokens, `# This is a line comment1.`);
        assert(lineComment1 !== null);
        assert.strictEqual(lineComment1.type, CMakeSimpleLexer.Comment);
        assert.strictEqual(commands.length, 1);
        const args = commands[0].argument_list();
        assert.strictEqual(args.length, 2);
        const lineComment2 = findTokenWithText(tokens, `# This is a line comment :)`);
        assert(lineComment2 !== null);
        assert.strictEqual(lineComment2.type, CMakeSimpleLexer.Comment);
        const lineComment3 = findTokenWithText(tokens, `# This is a line comment2.`);
        assert(lineComment3 !== null);
        assert.strictEqual(lineComment3.type, CMakeSimpleLexer.Comment);
        assert.strictEqual(errs, 0);
    });

    test('should parse bracket comment and bracket argument with correct line number', () => {
        const input = `#[[This is a bracket comment.
It runs until the close bracket.]]
set(VAR [=[This is a
multi-line argument]=])
message("\${VAR}")
`;
        const [tokens, tree, errs] = parseInput(input);
        const commands = tree.command_list();
        assert.strictEqual(commands.length, 2);
        assert.strictEqual(tokens.tokens.length, 14);
        const bracketComment = tokens.get(0);
        assert.strictEqual(bracketComment.type, CMakeSimpleLexer.Comment);
        const setCommand = commands[0];
        const setToken = setCommand.ID().symbol;
        assert.strictEqual(setToken.line, 3);
        const messageToken = commands[1].ID().symbol;
        assert.strictEqual(messageToken.line, 5);
    });
});