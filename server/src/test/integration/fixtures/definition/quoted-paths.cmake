include("include/helpers.cmake")
add_subdirectory("src")
configure_file("config/input.in" "config/output.txt")