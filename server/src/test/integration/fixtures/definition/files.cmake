configure_file(config/input.in config/output.txt)
add_library(sample STATIC sources/lib.cpp include/lib.h)
add_executable(tool sources/tool.cpp)
target_sources(sample PRIVATE sources/extra.cpp)