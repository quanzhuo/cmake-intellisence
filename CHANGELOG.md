# Change Log

## v0.3.5

Bug Fixes:

* 修复在 Windows 上，如果没有安装 msvc，获取 CMake 模块路径时会导致错误

## v0.3.4

Improvements:

* 在 if, elseif, while 命令中提供变量补全
* 通过 cmake --system-information 获取 cmake 模块路径

Bug Fixes:

* 修复变量，属性补全列表中带有重复项的问题，并更新单元测试

## v0.3.3

* 修复变量解析逻辑，确保正确处理变量位置并添加相关单元测试
* 语法重构，使之更加可读
* 修复文件补全时导致的崩溃问题
* 更新 README.md，添加开发环境设置说明

## v0.3.2

* 补全功能，使用在 builtin-cmds.json 中预定义的关键字
* 更新文档链接信息，针对 add_subdirectory 命令，tooltip 指向文件，而不是目录
* Fix #1: ()不在同一行的时候，执行格式化，)会自动格式化到行首

## v0.3.1

* 修复多行注释解析错误的问题
* 修复 Lexer 中存在的问题
* 添加更多的补全片段
* 更新语言配置，添加尖括号自动闭合
* 当光标位于 ${} 中时，执行变量补全

## v0.3.0

* 补全支持用户定义命令， 目标，属性
* add 'completionItem/resolve' support
* support pkg_check_modules completion
* show complete documentation for command when hover
* Add a setting to set path to pkg-config command
* use markdown format in Hover
* Fix #2: Unquoted arguments can contain quotes

## v0.2.2

* 参数补全支持 CMake 内置变量
* 重构补全逻辑，增加对 CMake 策略的补全
* 缓存 AST， 避免不必要的 AST 构建
* 修复参数 hover 报错的问题
* 增加设置项，可以设置 CMake 内置模块的路径
* 重构签名补全功能

## v0.2.1

* 添加 document link 特性
* 添加 shutdown 事件处理，清理资源
* 添加 block/endblock 等新命令
* 补全时显示文档
* 支持文件补全， 模块补全(find_package)
* 修复参数补全时，识别参数错误的问题

## v0.2.0

* 升级 antlr4 到 4.13.2， 使用 ts target
* 更新 CMake 语法
* 修复关键字(如 ’include‘) 不能作为参数的问题
* 根据上下文信息补全命令和参数
* 在注释中禁用 hover

## v0.1.3

* 还原cmake.tmLanguage.yml文件

## v0.1.2

* readme中增加中文描述

## v0.1.1

* 更新package.json中的keywords

## v0.1.0

* 用于 Kylin-IDE 的第一个版本
