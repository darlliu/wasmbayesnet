# WasmBayesNet

A high-performance C++20 and WebAssembly (WASM) library for constructing and computing Bayesian Networks interactively in the browser.

## Features

- **Modern C++ Core**: Written using C++20 features (smart pointers, `std::span`, `std::optional`, structured bindings) for a clean, memory-safe Graph DAG representing random variables.
- **Exact Inference Engine**: Computes exact marginal posterior probabilities for networks given evidence using full joint marginalization.
- **Zero-Dependency Frontend**: Includes an interactive graph builder built purely in Vanilla JS, HTML, CSS, and D3.js. (No Node/NPM/Webpack slop!).
- **Hardware Accelerated**: The complex math runs via highly structured C++ compiled natively to WebAssembly.

## Architecture

The project is split into two halves:

1. **`/src` - The C++ Engine**: Contains `Node.hpp`, `BayesNet.hpp` and the `wrapper.cpp` which exposes the C++ engine to JavaScript via Emscripten.
2. **`/frontend` - The UI**: A sleek, dark-mode, glassmorphism web interface powered by D3.js. 

### How inference works:
1. The user drags/creates a node in D3.js.
2. JavaScript calls `add_node` in the WASM `engine.js` module.
3. The user "Pins Evidence" to a variable in the UI (e.g., sets "Burglary" to True).
4. `set_evidence` is called across the WASM boundary. The C++ engine recalculates the posteriors.
5. JavaScript reads back the `get_marginals` memory pointer to update the UI progress bars instantly.

## Building the WebAssembly Math Engine

You must use **Emscripten** to compile the C++ source into the `.wasm` binary that the frontend consumes.

1. Install [Emscripten Toolchain](https://emscripten.org/docs/getting_started/downloads.html).
2. Run the compilation command:
   ```bash
   emcc src/wrapper.cpp -o frontend/engine.js -O3 -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap']" -s MODULARIZE=1 -s EXPORT_NAME="Module" -std=c++20
   ```
3. This will generate `engine.js` and `engine.wasm` directly into the `frontend/` directory.

## Running the Web App Locally

Because browsers strictly block loading local `.wasm` files via `file://` protocol (for security reasons), you **must** serve the frontend folder over HTTP.

Since there are no `node_modules` or dependencies, any static web server will work:

```bash
cd frontend
python -m http.server 8000
```
Then visit `http://localhost:8000/` in your browser.

## License
MIT (or GPL-3.0 per previous iteration).
