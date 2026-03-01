# C++ / WASM Bayesian Network App - Design Doc

This design doc outlines a high-performance web application combining a C++ compiled WebAssembly backend for inference and a D3.js frontend for visualization.

## Goal Description

Create a client-side (serverless) web application that allows users to interactively build and inspect Bayesian Networks. The frontend uses a zero-dependency JS architecture to render a D3 viewport, while the Bayesian inference math runs in hardware-accelerated C++ via WebAssembly.

## Modern C++ Goals (User Learning Focus)

Based on the existing `wasmpredictor` (which uses C++11 auto, basic unordered_maps, and older loop styles), the rewrite will intentionally introduce modern **C++17 and C++20 features** where they make structural sense, to serve as a learning resource:
- **`std::optional` / `std::variant` (C++17)**: Used for state returns and error handling instead of null pointers or magic numbers.
- **Smart Pointers (`std::unique_ptr`, `std::shared_ptr`) (C++11/14)**: We will move away from raw pointers in graph edges to clear ownership semantics.
- **Structured Bindings (C++17)**: E.g., `for (auto& [key, value] : map)`.
- **`std::span` (C++20)**: Instead of passing `std::vector` by reference for read-only contiguous arrays.
- **Concepts / auto in parameters (C++20)**: To simplify generic functional programming patterns over the graph nodes.

## The C++ Core Library (Rewrite)

The original prototype in `wasmpredictor` was tailored towards prefix/text prediction. For a true Bayesian Network, we will rewrite the core logic into a solid, general-purpose C++ library.

### Core Architecture
- **`Node`**: A class representing a random variable.
  - `id` (std::string)
  - `states` (vector<string>, e.g., ["True", "False"])
  - `parents` (vector of weak_ptrs or IDs to avoid cyclic ownership)
  - `cpt` (Conditional Probability Table - 1D array flattened from multi-dimensional state space)
- **`BayesNet`**: A class managing the network graph.
  - Maintains the list of nodes and edges (DAG).
  - Validates CPT sizes (a node with $P$ parents each with 2 states requires a CPT of size $2^{P+1}$).
- **`InferenceEngine`**: A class responsible for calculating probabilities.
  - **Exact Inference**: Builds the full Joint Probability Distribution and marginalizes it given current evidence. Suitable for small graphs.

## App Architecture

1. **Backend (C++ -> WASM)**:
   - The rewritten C++ library will act as the Engine.
   - We will write an Emscripten wrapper (`wrapper.cpp`) mapping `add_node`, `add_edge`, `get_marginal`, etc., using `EMSCRIPTEN_KEEPALIVE` and `extern "C"`.
   - **Build Step**: Compiled via Emscripten (`emcc`). The output is `engine.wasm` and `engine.js`. That is the *only* build dependency on this project. 

2. **Frontend (Pure JS & D3)**:
   - **Zero Node/NPM dependencies.**
   - `index.html`: Entry point that loads `engine.js` explicitly and `app.js` as an ES module.
   - `app.js`: Connects D3 canvas events (dragging, adding edges) to the WASM modules.
   - `style.css`: Pure Vanilla CSS (Glassmorphism aesthetics, dark mode).

## Core Functionalities

1. **Interactive Node-Link Canvas (D3.js)**:
   - **Nodes**: Represent random variables. Boolean (True/False) states initially.
   - **Edges**: Directed arrows representing causal dependency. 
   - **Interactions**: Drag to move nodes, click and drag to establish parent/child relationships.

2. **Probability Configuration Panel**:
   - Selecting a node opens a clean floating panel to set probabilities (Prior for root nodes, CPT for children).

3. **Inference & "Evidence" Pinning**:
   - Explicitly observe a variable ("pin" it to 100% True/False).
   - This passes an array of Evidence states to the `Module._infer()` WASM function. 
   - The WASM module returns the updated Probabilities array instantly back to UI.

4. **Presets / Templates**:
   - Pre-loaded "fun" templates (e.g. Bad Weather -> Murder).
