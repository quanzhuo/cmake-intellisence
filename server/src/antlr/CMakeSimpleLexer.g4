lexer grammar CMakeSimpleLexer;

@lexer::members {
    private nestingLevel: number = 0;
	private newLineCount: number = 1;
}

options {
	caseInsensitive = true;
}

channels {
	COMMENTS
}

ID options{
	caseInsensitive = false;
}: [a-zA-Z_] [a-zA-Z0-9_]*;

BracketArgument: '[' BracketNested ']';
QuotedArgument: '"' QuotedElement* '"';
UnquotedArgument: (UnquotedElement)+;
BracketComment: '#[' BracketNested ']' -> channel(COMMENTS);
LineComment: '#' ~[\r\n]* -> channel(COMMENTS);

// NL should be ignored in the following two cases 
// 1. NL between '(' and ')' 
// 2. NL between command invocations
IgnoreNLBetweenArgs:
	'\r'? '\n' { this.nestingLevel > 0 }? -> channel(HIDDEN);
IgnoreExtraNLBetweenCmds:
	'\r'? '\n' { this.newLineCount > 0 }? -> channel(HIDDEN);

NL: {this.newLineCount++;} '\r'? '\n';
WS: [ \t]+ -> skip;
LParen: '(' {this.nestingLevel++;};
RParen: ')' {this.nestingLevel--; this.newLineCount = 0;};

fragment EscapeSequence:
	EscapeIdentity
	| EscapeEncoded
	| EscapeSemicolon;
fragment EscapeIdentity options{
	caseInsensitive = false;
}: '\\' ~[a-zA-Z0-9;];
fragment EscapeEncoded: '\\t' | '\\r' | '\\n';
fragment EscapeSemicolon: '\\;';
fragment BracketNested: '=' BracketNested '=' | '[' .*? ']';
fragment QuotedElement: ~[\\"] | EscapeSequence | '\\' NL;

// Fix #2: Unquoted arguments can contain quotes, eg: add_definitions(-DLOG_DIR="${LOG_DIR}")
// https://github.com/quanzhuo/cmake-intellisence/issues/2
fragment UnquotedElement: ~[ \t\r\n()#\\] | EscapeSequence;