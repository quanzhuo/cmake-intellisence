include("local/include-local.cmake")
configure_file("config/input.in" "config/output.txt")
add_subdirectory("app")