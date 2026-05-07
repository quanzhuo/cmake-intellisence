include(${CMAKE_CURRENT_LIST_DIR}/include/helpers.cmake)
add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/src)
configure_file(${CMAKE_CURRENT_LIST_DIR}/config/input.in ${CMAKE_CURRENT_LIST_DIR}/config/output.txt)