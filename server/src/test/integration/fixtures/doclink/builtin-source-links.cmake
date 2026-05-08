include(${CMAKE_CURRENT_SOURCE_DIR}/local/include-local.cmake)
configure_file(${CMAKE_SOURCE_DIR}/config/input.in ${PROJECT_SOURCE_DIR}/config/output.txt)
add_subdirectory(${PROJECT_SOURCE_DIR}/app)
target_sources(test_lib PRIVATE ${CMAKE_SOURCE_DIR}/extra/extra.cpp)