# Change Log

## v0.2.2 (2024-12-05)

* 参数补全支持 CMake 内置变量
* 重构补全逻辑，增加对 CMake 策略的补全
* 缓存 AST， 避免不必要的 AST 构建
* 修复参数 hover 报错的问题
* 增加设置项，可以设置 CMake 内置模块的路径
* 重构签名补全功能

## v0.2.1 (2024-11-27)

* 添加 document link 特性
* 添加 shutdown 事件处理，清理资源
* 添加 block/endblock 等新命令
* 补全时显示文档
* 支持文件补全， 模块补全(find_package)
* 修复参数补全时，识别参数错误的问题

## v0.2.0 (2024-11-25)

* 升级 antlr4 到 4.13.2， 使用 ts target
* 更新 CMake 语法
* 修复关键字(如 ’include‘) 不能作为参数的问题
* 根据上下文信息补全命令和参数
* 在注释中禁用 hover

## v0.1.3 (2023-11-30)

* 还原cmake.tmLanguage.yml文件

## v0.1.2 (2023-10-12)

* readme中增加中文描述

## v0.1.1 (2023-04-28)

* 更新package.json中的keywords

## v0.1.0 (2023-04-13)

* 用于 Kylin-IDE 的第一个版本
