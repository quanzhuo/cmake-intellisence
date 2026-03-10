set(LIB_VAR "lib_value")

function(lib_func arg)
  message(STATUS ${arg})
endfunction()

root_func(${ROOT_VAR})
lib_func(${LIB_VAR})
