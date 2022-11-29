import { Diagnostic } from 'vscode-languageserver';
import ErrorListener from './parser/antlr4/error/ErrorListener';

export default class CMakeErrorListener extends ErrorListener {
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
            message: msg
        });
    }

    public getDiagnostics(): Diagnostic[] {
        return this.diagnostics;
    }

    public clearDiagnostics() {
        this.diagnostics = [];
    }
}