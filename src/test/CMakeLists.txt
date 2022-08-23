# This file is used to test the cmake-ls extension
cmake_minimum_required(VERSION 3.0)
project(Demo
    VERSION 1.0
    LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD_REQUIRED TRUE)

#[=[
This is bracket block comment
The second line in comment
]=]

# test bracket parameter
set(BRAKET_PARA [=[
First line in bracket parameter
Second line in bracket parameter
]=])

# numbers
set(DIGIT 100)
set(DIGIT 100.1)

# boolean constant
set(BOOL_TRUE YES)
set(BOOL_TRUE TRUE)
set(BOOL_FALSE NO)
set(BOOL_FALSE NOTFOUND)
set(BOOL_FALSE A-NOTFOUND)

# deprecated command
exec_program(dir)
install_files(dest so libc.so)

# flow control commands
if(TRUE)
    message(STATUS "This message will print")
endif()

set(INDEX 1)
while(TRUE)
    message(STATUS ${INDEX})
    math(EXPR INDEX "${INDEX} + 1")
    if (INDEX EQUAL 11)
        break()
    endif()
endwhile()

foreach(INDEX RANGE 10)
    message(STATUS ${INDEX})
endforeach()

# operator
if(DEFINED undefined_function)
endif()

if ("gaga" STRLESS_EQUAL "haha")
endif()

if (TRUE AND FALSE)
endif()

# usr defined functions
function(print)
    foreach(ARG IN LISTS ARGV)
    endforeach()
endfunction()

macro(macro_print)
endmacro()

# test for cache variable
set(STR_VAR "demo string" CACHE STRING "This is docstring" FORCE)
set(BOOL_VAR "demo bool" CACHE BOOL "This is docstring" FORCE)
set(FILEPATH_VAR "demo filepath" CACHE FILEPATH "This is docstring" FORCE)
set(PATH_VAR "demo path" CACHE PATH "This is docstring" FORCE)
set(INTERNAL_VAR "demo internal" CACHE INTERNAL "This is docstring" FORCE)

# variable reference
message(STATUS $ENV{PATH})
message(STATUS $CACHE{CMAKE_BUILD_TYPE})
message(STATUS "$ENV{PATH} plain strings")
message(STATUS "$CACHE{CMAKE_BUILD_TYPE}")
message(STATUS "${PATH}")
message(STATUS "${CMAKE_BUILD_TYPE}")

# generator expression
# The $<BOOL:...> check prevents adding anything if the property is empty,
# assuming the property value cannot be one of CMake's false constants.
set(prop $<TARGET_PROPERTY:tgt,INCLUDE_DIRECTORIES>)
set(prop "$<TARGET_PROPERTY:tgt,INCLUDE_DIRECTORIES>")
add_custom_target(run_some_tool
  COMMAND some_tool "$<$<BOOL:${prop}>:-I$<JOIN:${prop},;-I>>"
  COMMAND_EXPAND_LISTS
  VERBATIM
)

# string escape
set(VAR "This a \"in string")