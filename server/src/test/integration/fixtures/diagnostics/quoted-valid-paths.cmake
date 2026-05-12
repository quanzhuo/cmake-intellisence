include("existing/include-local.cmake")
add_subdirectory("existing/subdir")
configure_file("existing/config.in" "generated/config.out")