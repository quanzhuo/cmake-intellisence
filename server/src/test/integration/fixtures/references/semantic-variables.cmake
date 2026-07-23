set(SHARED_NAME initial)
message("${SHARED_NAME}")
message("SHARED_NAME")
message("before
${SHARED_NAME}
after")
function(first SHARED_NAME)
    message("${SHARED_NAME}")
endfunction()
function(second SHARED_NAME)
    message("${SHARED_NAME}")
endfunction()
