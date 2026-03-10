cmake_minimum_required(VERSION 3.10)
project(RefTest)

set(MY_VAR "test_value")
set(OTHER_VAR ${MY_VAR})
message(STATUS "Value: ${MY_VAR}")

function(my_custom_macro arg1)
    message(${arg1})
    message(${MY_VAR})
endfunction()

my_custom_macro(foo)

include(utils.cmake)
my_custom_macro(bar)

set(COMPLEX_VAR "prefix_${MY_VAR}_suffix")
message("Double resolve: ${${MY_VAR}}")

