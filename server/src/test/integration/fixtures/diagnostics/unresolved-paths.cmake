set(MAYBE_INCLUDE ${UNRESOLVED_DIR}/include-local.cmake)
set(MAYBE_CONFIG ${UNRESOLVED_DIR}/config.in)
set(MAYBE_SOURCE ${UNRESOLVED_DIR}/lib.cpp)

include(${MAYBE_INCLUDE})
add_subdirectory(${UNRESOLVED_DIR})
configure_file(${MAYBE_CONFIG} generated/config.out)
add_library(test_lib STATIC ${MAYBE_SOURCE})
add_executable(test_app ${MAYBE_SOURCE})