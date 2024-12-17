lexer grammar CMakeSimpleLexer;

@lexer::members {
    private nestingLevel: number = 0;
    private newLineCount: number = 1;

    private start_line: number;
    private start_col: number;

    HandleComment() {
        this.start_line = this.line;
        this.start_col = this.column - 1;
        let cs = this._input;
        if (cs.LA(1) === 91) { /* '[' */
            let sep = this.skip_sep(cs);
            if (sep >= 2) {
                this.read_long_string(cs, sep);
                return;
            }
        }
        while (cs.LA(1) !== 10 /* '\n' */ && cs.LA(1) !== -1) {
            cs.consume();
        }
    }

    read_long_string(cs: CharStream, sep: number) {
        let done = false;
        cs.consume();
        for (; ;) {
            let c = cs.LA(1);
            switch (c) {
                case -1:
                    done = true;
                    //                    let listener = this.getErrorListenerDispatch();
                    //                    listener.syntaxError(this, null, this.start_line, this.start_col, "unfinished long comment", null);
                    break;
                case 93: /* ']' */
                    if (this.skip_sep(cs) === sep) {
                        cs.consume();
                        done = true;
                    }
                    break;
                default:
                    if (cs.LA(1) === -1) {
                        done = true;
                        break;
                    }
                    cs.consume();
                    break;
            }
            if (done) {
                break;
            }
        }
    }

    skip_sep(cs: CharStream): number {
        let count = 0;
        let s = cs.LA(1);
        cs.consume();
        while (cs.LA(1) === 61 /* '=' */) {
            cs.consume();
            count++;
        }
        if (cs.LA(1) === s) { count += 2; }
        else if (count === 0) { count = 1; }
        else { count = 0; }
        return count;
    }

    IsLine1Col0(): boolean {
        let cs = this._input;
        return cs.index === 1;
    }
}

options {
    caseInsensitive = true;
}

channels {
    COMMENTS
}

ID options{ caseInsensitive = false; }: [a-zA-Z_] [a-zA-Z0-9_]*;

QuotedArgument: '"' QuotedElement* '"';
UnquotedArgument: (UnquotedElement)+;
Comment: '#' { this.HandleComment(); } -> channel(COMMENTS);
BracketArgument: '[' BracketNested ']';

// NL should be ignored in the following two cases 
// 1. NL between '(' and ')' 
// 2. NL between command invocations
IgnoreNLBetweenArgs: '\r'? '\n' { this.nestingLevel > 0 }? -> channel(HIDDEN);
IgnoreExtraNLBetweenCmds: '\r'? '\n' { this.newLineCount > 0 }? -> channel(HIDDEN);

NL: {this.newLineCount++;} '\r'? '\n';
WS: [ \t]+ -> skip;
LParen: '(' {this.nestingLevel++;};
RParen: ')' {this.nestingLevel--; this.newLineCount = 0;};
BracketNested: '=' BracketNested '=' | '[' .*? ']';

fragment EscapeSequence: EscapeIdentity | EscapeEncoded | EscapeSemicolon;
fragment EscapeIdentity options{ caseInsensitive = false; }: '\\' ~[a-zA-Z0-9;];
fragment EscapeEncoded: '\\t' | '\\r' | '\\n';
fragment EscapeSemicolon: '\\;';
fragment QuotedElement: ~[\\"] | EscapeSequence | '\\' NL;

// Fix #2: Unquoted arguments can contain quotes, eg: add_definitions(-DLOG_DIR="${LOG_DIR}")
// https://github.com/quanzhuo/cmake-intellisence/issues/2
fragment UnquotedElement: ~[ \t\r\n()#\\] | EscapeSequence;