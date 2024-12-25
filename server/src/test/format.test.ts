import { CharStreams, CommonTokenStream, ParseTreeWalker } from 'antlr4';
import * as assert from 'assert';
import { Formatter } from '../format';
import CMakeSimpleLexer from '../generated/CMakeSimpleLexer';
import CMakeSimpleParser from '../generated/CMakeSimpleParser';
import { SyntaxErrorListener } from './cmakeSimple.test';

suite('Formatter Tests', () => {
    test('Format simple commands', () => {
        const input = `
set(VAR value)
message("Hello World")
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Format with indentation', () => {
        const input = `
function(MyFunction)
set(VAR value)
endfunction()
`;
        const expectedOutput = `
function(MyFunction)
    set(VAR value)
endfunction()
`;

        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle nested functions and macros', () => {
        const input = `
function(OuterFunction)
macro(InnerMacro)
set(VAR value)
endmacro()
endfunction()
`;
        const expectedOutput = `
function(OuterFunction)
    macro(InnerMacro)
        set(VAR value)
    endmacro()
endfunction()
`;

        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle if-elseif-else-endif blocks', () => {
        const input = `
if(CONDITION)
message("True")
elseif(OTHER_CONDITION)
message("Maybe")
else()
message("False")
endif()
`;
        const expectedOutput = `
if(CONDITION)
    message("True")
elseif(OTHER_CONDITION)
    message("Maybe")
else()
    message("False")
endif()
`;

        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Preserve comments and newlines', () => {
        const input = `
# This is a comment
function(MyFunction) # Function start
set(VAR value) # Set variable
endfunction() # Function end

# Another comment
`;
        const expectedOutput = `
# This is a comment
function(MyFunction) # Function start
    set(VAR value) # Set variable
endfunction() # Function end

# Another comment
`;

        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle commands without arguments', () => {
        const input = `
project(MyProject)
enable_testing()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle complex expressions and variables', () => {
        const input = `
if(EXISTS "\${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt")
add_subdirectory("\${CMAKE_CURRENT_SOURCE_DIR}/subdir")
endif()
`;
        const expectedOutput = `
if(EXISTS "\${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt")
    add_subdirectory("\${CMAKE_CURRENT_SOURCE_DIR}/subdir")
endif()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Format arguments spanning multiple lines', () => {
        const input = `
set(VAR
"value1"
"value2"
)
`;
        const expectedOutput = `
set(VAR
    "value1"
    "value2"
)
`;

        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle empty files gracefully', () => {
        const input = ``;

        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle comments inline with code', () => {
        const input = `
set(VAR value) # Setting VAR
if(VAR)
message("Variable is set") # Message output
endif()
`;
        const expectedOutput = `
set(VAR value) # Setting VAR
if(VAR)
    message("Variable is set") # Message output
endif()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle mixed indentation', () => {
        const input = `
function(MyFunction)
  if(CONDITION)
set(VAR value)
   endif()
endfunction()
`;
        const expectedOutput = `
function(MyFunction)
    if(CONDITION)
        set(VAR value)
    endif()
endfunction()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle complex nesting', () => {
        const input = `
function(OuterFunction)
if(CONDITION)
foreach(item \${ITEMS})
set(VAR value)
endforeach()
endif()
endfunction()
`;
        const expectedOutput = `
function(OuterFunction)
    if(CONDITION)
        foreach(item \${ITEMS})
            set(VAR value)
        endforeach()
    endif()
endfunction()
`;

        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle bracket arguments', () => {
        const input = `
function(MyFunction)
set(VAR [=[
This is a
multi-line
string
]=])
endfunction()
`;
        const expectedOutput = `
function(MyFunction)
    set(VAR [=[
This is a
multi-line
string
]=])
endfunction()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('should handle bracket comments', () => {
        const input = String.raw`
#[[This is a bracket comment.
It runs until the close bracket.]]
message("First Argument\n" #[[Bracket Comment]] "Second Argument")
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle complex command arguments', () => {
        const input = `
add_definitions(-DLOG_DIR="\${LOG_DIR}")
add_definitions(-DVERSION="1.0.0")
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle commands with multiple complex arguments', () => {
        const input = `
add_executable(MyApp main.cpp utils.cpp)
target_include_directories(MyApp PRIVATE \${CMAKE_SOURCE_DIR}/include)
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle nested if-else with complex conditions', () => {
        const input = `
if(EXISTS "\${CMAKE_SOURCE_DIR}/config.h")
    add_definitions(-DHAS_CONFIG)
else()
    add_definitions(-DNO_CONFIG)
endif()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle commands with multiple line arguments', () => {
        const input = `
set(SOURCES
    main.cpp
    utils.cpp
    config.cpp
)
`;
        const expectedOutput = `
set(SOURCES
    main.cpp
    utils.cpp
    config.cpp
)
`;

        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle commands with nested variables', () => {
        const input = `
set(MY_VAR "\${CMAKE_SOURCE_DIR}/\${CMAKE_BUILD_TYPE}")
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle multi-line comments', () => {
        const input = `
# This is a comment
# that spans multiple lines
function(MyFunction)
set(VAR value)
endfunction()
`;
        const expectedOutput = `
# This is a comment
# that spans multiple lines
function(MyFunction)
    set(VAR value)
endfunction()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('should add newline at end of file', () => {
        const input = `set(VAR value)`;
        const expectedOutput = `set(VAR value)\n`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle newline in front of file', () => {
        const input = `\nset(VAR value)`;
        const expectedOutput = `\nset(VAR value)\n`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('Handle generator expressions 1', () => {
        const input = `
target_include_directories(tgt PRIVATE /opt/include/$<CXX_COMPILER_ID>)
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle generator expressions 2', () => {
        const input = `
target_compile_definitions(tgt PRIVATE
    $<$<VERSION_LESS:$<CXX_COMPILER_VERSION>,4.2.0>:OLD_COMPILER>
)
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle complex conditional expressions', () => {
        const input = `
if(DEFINED ENV{MY_ENV_VAR} AND "\${MY_VAR}" STREQUAL "value")
    message("Condition met")
endif()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('Handle large files efficiently', () => {
        const input = `
project(LargeProject)
` + 'set(VAR value)\n'.repeat(1000) + `
endproject()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('should handle file with only comment in it', () => {
        const input = `
# This is a comment
#[[This is comment Too]]`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('should handle file with only newlines', () => {
        const input = `


`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, input);
        assert.strictEqual(errs, 0);
    });

    test('should indent correct if right paren is on next line 1', () => {
        const input = `
function(print args)
    message(args
)
endfunction()
`;
        const expectedOutput = `
function(print args)
    message(args
    )
endfunction()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('should indent correct if right paren is on next line 2', () => {
        const input = `
function(print args)
if (true)
message(args
)
endif()   
endfunction()
`;
        const expectedOutput = `
function(print args)
    if(true)
        message(args
        )
    endif()
endfunction()
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });

    test('should preserve newlines between commands', () => {
        const input = `
set(VAR value)


set(VAR2 value2)
`;
        const expectedOutput = `
set(VAR value)


set(VAR2 value2)
`;
        const [formatted, errs] = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
        assert.strictEqual(errs, 0);
    });
});

function formatCMake(input: string, indentSize: number): [string, number] {
    const chars = CharStreams.fromString(input);
    const lexer = new CMakeSimpleLexer(chars);
    const tokens = new CommonTokenStream(lexer);
    const parser = new CMakeSimpleParser(tokens);
    parser.removeErrorListeners();
    const syntaxErrorListener = new SyntaxErrorListener();
    parser.addErrorListener(syntaxErrorListener);
    const tree = parser.file();
    const formatter = new Formatter(indentSize, tokens);
    ParseTreeWalker.DEFAULT.walk(formatter, tree);
    return [formatter.formatted, syntaxErrorListener.errorCount];
}