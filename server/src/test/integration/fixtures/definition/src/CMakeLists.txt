set(SRC_VAR "src_value")

function(src_func arg)
  message(STATUS ${arg})
endfunction()

add_subdirectory(lib)
add_subdirectory(lib2)

root_func(${ROOT_VAR})
src_func(${SRC_VAR})

# Test sibling / child variable pollution
message(${LIB_VAR})
message(${LIB2_VAR})
