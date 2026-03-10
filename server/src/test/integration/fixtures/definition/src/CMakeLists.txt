set(SRC_VAR "src_value")

function(src_func arg)
  message(STATUS ${arg})
endfunction()

add_subdirectory(lib)

root_func(${ROOT_VAR})
src_func(${SRC_VAR})
