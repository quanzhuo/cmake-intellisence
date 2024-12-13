import { CharStreams, CommonTokenStream, ParseTreeWalker } from 'antlr4';
import * as assert from 'assert';
import { Formatter } from '../format';
import CMakeSimpleLexer from '../generated/CMakeSimpleLexer';
import CMakeSimpleParser from '../generated/CMakeSimpleParser';

suite('Formatter Tests', () => {
    test('Format simple commands', () => {
        const input = `
set(VAR value)
message("Hello World")
`;
        const expectedOutput = `
set(VAR value)
message("Hello World")
`;

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
    });

    test('Handle commands without arguments', () => {
        const input = `
project(MyProject)
enable_testing()
`;
        const expectedOutput = `
project(MyProject)
enable_testing()
`;

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
    });

    test('Handle empty files gracefully', () => {
        const input = ``;
        const expectedOutput = ``;

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted, expectedOutput);
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
    });

    test('Maintain bracket arguments correctly', () => {
        const input = `
execute_process(COMMAND
    echo "Line1"
    echo "Line2"
)
`;
        const expectedOutput = `
execute_process(COMMAND
    echo "Line1"
    echo "Line2"
)
`;

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
    });

    test('Handle complex command arguments', () => {
        const input = `
add_definitions(-DLOG_DIR="\${LOG_DIR}")
add_definitions(-DVERSION="1.0.0")
`;
        const expectedOutput = `
add_definitions(-DLOG_DIR="\${LOG_DIR}")
add_definitions(-DVERSION="1.0.0")
`;

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
    });

    test('Handle commands with multiple complex arguments', () => {
        const input = `
add_executable(MyApp main.cpp utils.cpp)
target_include_directories(MyApp PRIVATE \${CMAKE_SOURCE_DIR}/include)
`;
        const expectedOutput = `
add_executable(MyApp main.cpp utils.cpp)
target_include_directories(MyApp PRIVATE \${CMAKE_SOURCE_DIR}/include)
`;

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
    });

    test('Handle nested if-else with complex conditions', () => {
        const input = `
if(EXISTS "\${CMAKE_SOURCE_DIR}/config.h")
    add_definitions(-DHAS_CONFIG)
else()
    add_definitions(-DNO_CONFIG)
endif()
`;
        const expectedOutput = `
if(EXISTS "\${CMAKE_SOURCE_DIR}/config.h")
    add_definitions(-DHAS_CONFIG)
else()
    add_definitions(-DNO_CONFIG)
endif()
`;

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
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

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
    });

    test('Handle commands with nested variables', () => {
        const input = `
set(MY_VAR "\${CMAKE_SOURCE_DIR}/\${CMAKE_BUILD_TYPE}")
`;
        const expectedOutput = `
set(MY_VAR "\${CMAKE_SOURCE_DIR}/\${CMAKE_BUILD_TYPE}")
`;

        const formatted = formatCMake(input, 4);
        assert.strictEqual(formatted.trim(), expectedOutput.trim());
    });
});

function formatCMake(input: string, indentSize: number): string {
    const chars = CharStreams.fromString(input);
    const lexer = new CMakeSimpleLexer(chars);
    const tokens = new CommonTokenStream(lexer);
    const parser = new CMakeSimpleParser(tokens);
    const tree = parser.file();
    const formatter = new Formatter(indentSize, tokens);
    ParseTreeWalker.DEFAULT.walk(formatter as any, tree);
    return formatter.formatted;
}