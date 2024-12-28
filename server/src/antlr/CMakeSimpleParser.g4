parser grammar CMakeSimpleParser;

options {
	tokenVocab = CMakeSimpleLexer;
}

file: (command NL)* command ? EOF; // every command except the last must be terminated with newline
command: ID LP argument* RP;
argument:
	QuotedArgument
	| BracketArgument
	| UnquotedArgument
	| ID
	| LP argument* RP;