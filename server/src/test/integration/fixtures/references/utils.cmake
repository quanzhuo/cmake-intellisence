set(MY_VAR "overwritten")
message("Inside utils: ${MY_VAR}")

my_custom_macro(baz)

function(utils_func)
    # do nothing
endfunction()

