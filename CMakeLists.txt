cmake_minimum_required(VERSION 3.13)
project(wasmbayesnet)

# Set the C++ standard to 20 to fulfill the learning goal
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED True)

# Core Library
# We will pull all .cpp and .hpp files from the src directory
file(GLOB_RECURSE SOURCES "src/*.cpp")

# Depending on if we are cross compiling to Emscripten or building locally
if(EMSCRIPTEN)
    add_executable(wasmbayesnet ${SOURCES})
    set_target_properties(wasmbayesnet PROPERTIES LINK_FLAGS "-s MODULARIZE=1 -s EXPORT_NAME='BayesEngine' -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap']")
else()
    # Build locally just for syntax checking / basic tests
    add_executable(wasmbayesnet_test ${SOURCES})
endif()
