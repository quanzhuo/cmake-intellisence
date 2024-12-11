# Description

CMake IntelliSense is a Visual Studio Code extension that support CMake language. It provides features such as syntax highlighting, semantic tokens, and code completion for CMake scripts. 

## Feedback

This extension is still under development, you may encounter bugs or missing features. If you have any suggestions or find any bugs, please feel free to open an issue on [gitee](https://gitee.com/openKylin/cmake-intellisence/issues) or [github](https://github.com/quanzhuo/cmake-intellisence/issues). Your feedback is highly appreciated.

## Requirements

This extension is written in TypeScript, no other runtime dependencies are required. You should have [CMake](https://cmake.org/download/) installed.

## Features

+ syntax highlight
+ semantic tokens
+ commands, variable, properties... auto complete
+ document format
+ document link
+ go to defination
+ publish diagnostics
+ code action

![demo](https://github.com/quanzhuo/cmake-intellisence/raw/main/images/demo.gif)

## Development

This project use antlr4 to generate the parser and lexer for CMake language. You need to setup antlr4 command line tool before you start development.

1. Install Java JDK/JRE, make sure java command is available in your terminal
2. Download [antlr-4.13.2-complete.jar](https://www.antlr.org/download/antlr-4.13.2-complete.jar)
3. Add a script named `antlr4` in your path, and set the script content as follows:

on Linux/macOS, you can name the script `antlr4` and add execute permission to it, then put it in your path. The content of the script is as follows:
```bash
java -jar /path/to/antlr-4.13.2-complete.jar "$@"
```

on Windows, you can name the script `antlr4.bat` and put it in your path. The content of the script is as follows:
```bat
java -jar C:\path\to\antlr-4.13.2-complete.jar %*
```

After setting up antlr4 command line tool, you can flow the steps below to start development:

1. Clone the repository and open it in Visual Studio Code
2. Run `npm install` to install dependencies
3. Run `npm run develop` to compile the source code
4. Select `Client + Server` in the debug panel and press `F5` to start the extension


## Todo

+ Add more LSP features
+ Performance optimization
+ Unit/Integeation tests
