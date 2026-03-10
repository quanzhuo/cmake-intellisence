set(HELPER_VAR "helper")

function(helper_func arg)
  message(STATUS ${arg})
endfunction()

macro(helper_macro arg)
  message(STATUS ${arg})
endmacro()
