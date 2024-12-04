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

1. Clone the repository and open it in Visual Studio Code
2. Run `npm install` to install dependencies
3. Run `npm run develop` to compile the source code
4. Select `Client + Server` in the debug panel and press `F5` to start the extension


## Todo

+ Add more LSP features
+ Performance optimization
+ Unit/Integeation tests
