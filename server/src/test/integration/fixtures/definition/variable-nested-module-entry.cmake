set(CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}/custom-modules")
set(MODULE_NAME Sub/Mod)
include(${MODULE_NAME})
nested_module_helper()
