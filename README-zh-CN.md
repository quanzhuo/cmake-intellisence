# 描述

CMake IntelliSense 是一个 VSCode 扩展，提供 CMake 脚本的语法高亮、语义着色、文档格式化和代码补全等功能。

## 反馈

本扩展仍在开发中，您可能会遇到 bug 或缺失的功能。如果您有任何建议或发现 bug，欢迎在 [github](https://github.com/quanzhuo/cmake-intellisence/issues) 提交 issue。非常感谢您的反馈！

## 依赖要求

本扩展无需其他运行时依赖。您只需安装 [CMake](https://cmake.org/download/)。

## 功能特性

+ 语法高亮
+ 语义着色
+ 命令、变量、属性等自动补全
+ 文档格式化
+ 文档链接
+ 跳转到定义
+ 诊断信息发布
+ 代码操作

![demo](https://github.com/quanzhuo/cmake-intellisence/raw/main/images/demo.gif)

## 开发说明

**注意**：本节介绍开发/修改本扩展所需的开发环境配置。如果您只想使用本扩展，直接安装即可，无需额外配置。

本项目使用 antlr4 生成 CMake 语言的词法分析器和语法分析器。在开始开发前，您需要配置 antlr4 命令行工具。

1. 安装 Java JDK/JRE，确保终端可用 java 命令
2. 下载 [antlr-4.13.2-complete.jar](https://www.antlr.org/download/antlr-4.13.2-complete.jar)
3. 在您的 PATH 中添加一个名为 `antlr4` 的脚本，内容如下：

在 Linux/macOS 下，可以将脚本命名为 `antlr4`，赋予执行权限后放入 PATH，内容如下：
```bash
java -jar /path/to/antlr-4.13.2-complete.jar "$@"
```

在 Windows 下，可以将脚本命名为 `antlr4.bat` 并放入 PATH，内容如下：
```bat
java -jar C:\path\to\antlr-4.13.2-complete.jar %*
```

配置好 antlr4 命令行工具后，按如下步骤开始开发：

1. 克隆本仓库并用 Visual Studio Code 打开
2. 运行 `npm install` 安装依赖
3. 运行 `npm run develop` 编译源码
4. 在调试面板选择 `Client + Server`，按 `F5` 启动扩展

## 待办事项

+ 增加更多 LSP 功能
+ 性能优化
+ 单元/集成测试
