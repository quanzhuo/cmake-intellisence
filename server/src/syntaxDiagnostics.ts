import { ErrorListener } from 'antlr4';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';

export default class SyntaxErrorListener extends ErrorListener<string> {
    private diagnostics: Diagnostic[] = [];

    /**
     * 
     * @param recognizer 
     * @param offendingSymbol 
     * @param line start from 1
     * @param column start from 0
     * @param msg 
     * @param e 
     */
    syntaxError(recognizer, offendingSymbol, line, column, msg, e) {
        this.diagnostics.push({
            range: {
                start: {
                    line: line - 1,
                    character: column
                },
                end: {
                    line: line - 1,
                    character: column + offendingSymbol.text.length
                }
            },
            severity: DiagnosticSeverity.Error,
            source: 'cmake-intellisence',
            message: msg
        });
    }

    public getSyntaxErrors(): Diagnostic[] {
        return this.diagnostics;
    }

    public clearSyntaxErrors() {
        this.diagnostics = [];
    }
}