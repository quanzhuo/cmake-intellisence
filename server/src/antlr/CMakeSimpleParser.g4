parser grammar CMakeSimpleParser;

options {
	tokenVocab = CMakeSimpleLexer;
}

file: (command NL)* EOF; // every command except the last must be terminated with newline
command: ID LParen argument* RParen;
argument:
	QuotedArgument
	| BracketArgument
	| UnquotedArgument
	| ID
	| LParen argument* RParen;