import * as assert from 'assert';
import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import * as antlr4 from 'antlr4';
import { SymbolListener } from '../docSymbols';
import { ParseTreeWalker } from 'antlr4';
import CMakeLexer from '../generated/CMakeLexer';
import CMakeParser from '../generated/CMakeParser';

suite('SymbolListener Comprehensive Tests', () => {
    test('should handle nested macros', () => {
        const input = `
            macro(OuterMacro)
                macro(InnerMacro)
                    set(VAR1 value1)
                endmacro()
            endmacro()
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 1);
        const outerMacro = symbols[0];
        assert.strictEqual(outerMacro.name, 'OuterMacro');
        assert.strictEqual(outerMacro.kind, SymbolKind.Function);
        assert.strictEqual(outerMacro.children.length, 1);
        const innerMacro = outerMacro.children[0];
        assert.strictEqual(innerMacro.name, 'InnerMacro');
        assert.strictEqual(innerMacro.kind, SymbolKind.Function);
        assert.strictEqual(innerMacro.children.length, 1);
        assert.strictEqual(innerMacro.children[0].name, 'VAR1');
        assert.strictEqual(innerMacro.children[0].kind, SymbolKind.Variable);
    });

    test('should handle variables in global scope and inside functions/macros', () => {
        const input = `
            set(GLOBAL_VAR value)
            function(MyFunction)
                set(FUNC_VAR value)
            endfunction()
            macro(MyMacro)
                set(MACRO_VAR value)
            endmacro()
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 3);
        // Global variable
        assert.strictEqual(symbols[0].name, 'GLOBAL_VAR');
        assert.strictEqual(symbols[0].kind, SymbolKind.Variable);
        // Function and its variable
        assert.strictEqual(symbols[1].name, 'MyFunction');
        assert.strictEqual(symbols[1].kind, SymbolKind.Function);
        assert.strictEqual(symbols[1].children.length, 1);
        assert.strictEqual(symbols[1].children[0].name, 'FUNC_VAR');
        assert.strictEqual(symbols[1].children[0].kind, SymbolKind.Variable);
        // Macro and its variable
        assert.strictEqual(symbols[2].name, 'MyMacro');
        assert.strictEqual(symbols[2].kind, SymbolKind.Function);
        assert.strictEqual(symbols[2].children.length, 1);
        assert.strictEqual(symbols[2].children[0].name, 'MACRO_VAR');
        assert.strictEqual(symbols[2].children[0].kind, SymbolKind.Variable);
    });

    test('should handle symbols with the same name in different scopes', () => {
        const input = `
            set(VAR value_global)
            function(MyFunction)
                set(VAR value_function)
                function(NestedFunction)
                    set(VAR value_nested)
                endfunction()
            endfunction()
            macro(MyMacro)
                set(VAR value_macro)
            endmacro()
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 3);
        // Global variable
        assert.strictEqual(symbols[0].name, 'VAR');
        assert.strictEqual(symbols[0].kind, SymbolKind.Variable);
        // Function and its variable
        const myFunction = symbols[1];
        assert.strictEqual(myFunction.name, 'MyFunction');
        assert.strictEqual(myFunction.kind, SymbolKind.Function);
        assert.strictEqual(myFunction.children.length, 2);
        assert.strictEqual(myFunction.children[0].name, 'VAR');
        assert.strictEqual(myFunction.children[0].kind, SymbolKind.Variable);
        // Nested function and its variable
        const nestedFunction = myFunction.children[1];
        assert.strictEqual(nestedFunction.name, 'NestedFunction');
        assert.strictEqual(nestedFunction.kind, SymbolKind.Function);
        assert.strictEqual(nestedFunction.children.length, 1);
        assert.strictEqual(nestedFunction.children[0].name, 'VAR');
        assert.strictEqual(nestedFunction.children[0].kind, SymbolKind.Variable);
        // Macro and its variable
        const myMacro = symbols[2];
        assert.strictEqual(myMacro.name, 'MyMacro');
        assert.strictEqual(myMacro.kind, SymbolKind.Function);
        assert.strictEqual(myMacro.children.length, 1);
        assert.strictEqual(myMacro.children[0].name, 'VAR');
        assert.strictEqual(myMacro.children[0].kind, SymbolKind.Variable);
    });

    test('should handle functions/macros without variables', () => {
        const input = `
            function(EmptyFunction)
            endfunction()
            macro(EmptyMacro)
            endmacro()
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 2);
        // Empty function
        assert.strictEqual(symbols[0].name, 'EmptyFunction');
        assert.strictEqual(symbols[0].kind, SymbolKind.Function);
        assert.strictEqual(symbols[0].children.length, 0);
        // Empty macro
        assert.strictEqual(symbols[1].name, 'EmptyMacro');
        assert.strictEqual(symbols[1].kind, SymbolKind.Function);
        assert.strictEqual(symbols[1].children.length, 0);
    });

    test('should handle deeply nested functions and macros', () => {
        const input = `
            function(FunctionLevel1)
                macro(MacroLevel2)
                    function(FunctionLevel3)
                        macro(MacroLevel4)
                            set(VAR value)
                        endmacro()
                    endfunction()
                endmacro()
            endfunction()
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 1);
        const functionLevel1 = symbols[0];
        assert.strictEqual(functionLevel1.name, 'FunctionLevel1');
        assert.strictEqual(functionLevel1.kind, SymbolKind.Function);
        assert.strictEqual(functionLevel1.children.length, 1);
        const macroLevel2 = functionLevel1.children[0];
        assert.strictEqual(macroLevel2.name, 'MacroLevel2');
        assert.strictEqual(macroLevel2.kind, SymbolKind.Function);
        assert.strictEqual(macroLevel2.children.length, 1);
        const functionLevel3 = macroLevel2.children[0];
        assert.strictEqual(functionLevel3.name, 'FunctionLevel3');
        assert.strictEqual(functionLevel3.kind, SymbolKind.Function);
        assert.strictEqual(functionLevel3.children.length, 1);
        const macroLevel4 = functionLevel3.children[0];
        assert.strictEqual(macroLevel4.name, 'MacroLevel4');
        assert.strictEqual(macroLevel4.kind, SymbolKind.Function);
        assert.strictEqual(macroLevel4.children.length, 1);
        assert.strictEqual(macroLevel4.children[0].name, 'VAR');
        assert.strictEqual(macroLevel4.children[0].kind, SymbolKind.Variable);
    });

    test('should handle files with only comments', () => {
        const input = `
            # This is a comment
            # Another comment line
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 0);
    });

    test('should handle empty files', () => {
        const input = ``;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 0);
    });

    // test('should handle incomplete commands gracefully', () => {
    //     const input = `
    //         function(IncompleteFunction
    //             set(VAR value)
    //     `;
    //     const symbols = parseSymbols(input);
    //     // Depending on the parser's error handling, we might get partial results or no results
    //     // For the purpose of this test, we expect no symbols due to syntax error
    //     assert.strictEqual(symbols.length, 0);
    // });

    test('should handle variables defined after function ends', () => {
        const input = `
            function(MyFunction)
                # No variables inside function
            endfunction()
            set(GLOBAL_VAR value)
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 2);
        // Function without variables
        assert.strictEqual(symbols[0].name, 'MyFunction');
        assert.strictEqual(symbols[0].kind, SymbolKind.Function);
        assert.strictEqual(symbols[0].children.length, 0);
        // Global variable
        assert.strictEqual(symbols[1].name, 'GLOBAL_VAR');
        assert.strictEqual(symbols[1].kind, SymbolKind.Variable);
    });

    test('should handle functions/macro with arguments', () => {
        const input = `
            function(MyFunction ARG1 ARG2)
                set(VAR value)
            endfunction()
            macro(MyMacro ARG1 ARG2)
                set(VAR value)
            endmacro()
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 2);
        // Function with arguments
        assert.strictEqual(symbols[0].name, 'MyFunction');
        assert.strictEqual(symbols[0].kind, SymbolKind.Function);
        // Arguments are not considered symbols in this context
        assert.strictEqual(symbols[0].children.length, 1);
        assert.strictEqual(symbols[0].children[0].name, 'VAR');
        // Macro with arguments
        assert.strictEqual(symbols[1].name, 'MyMacro');
        assert.strictEqual(symbols[1].kind, SymbolKind.Function);
        assert.strictEqual(symbols[1].children.length, 1);
        assert.strictEqual(symbols[1].children[0].name, 'VAR');
    });

    test('should handle variables with various value types', () => {
        const input = `
            set(VAR1 "String Value")
            set(VAR2 1234)
            set(VAR3 ON)
            set(VAR4 OFF)
        `;
        const symbols = parseSymbols(input);
        assert.strictEqual(symbols.length, 4);
        assert.strictEqual(symbols[0].name, 'VAR1');
        assert.strictEqual(symbols[1].name, 'VAR2');
        assert.strictEqual(symbols[2].name, 'VAR3');
        assert.strictEqual(symbols[3].name, 'VAR4');
    });
});

function parseSymbols(input: string): DocumentSymbol[] {
    const chars = antlr4.CharStreams.fromString(input);
    const lexer = new CMakeLexer(chars);
    const tokens = new antlr4.CommonTokenStream(lexer);
    const parser = new CMakeParser(tokens);
    const tree = parser.file();
    const listener = new SymbolListener();
    ParseTreeWalker.DEFAULT.walk(listener as any, tree);
    return listener.getSymbols();
}