cmake_minimum_required(VERSION 3.10)
project(DefTest)

set(ROOT_VAR "root_value")

function(root_func arg)
  message(STATUS ${arg})
endfunction()

include(include/helpers.cmake)

add_subdirectory(src)

root_func(${ROOT_VAR})
helper_func(${HELPER_VAR})
helper_macro(hello)
