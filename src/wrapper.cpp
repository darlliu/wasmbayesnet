#include "BayesNet.hpp"
#include <iostream>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

// Global network instance for WebAssembly to interact with statically
bayes::BayesNet global_net;

extern "C" {

EMSCRIPTEN_KEEPALIVE
void create_node(const char* id, int num_states) {
    std::vector<std::string> states;
    for (int i = 0; i < num_states; ++i) {
        states.push_back("State_" + std::to_string(i));
    }
    global_net.add_node(id, states);
}

EMSCRIPTEN_KEEPALIVE
void add_edge(const char* parent_id, const char* child_id) {
    global_net.add_edge(parent_id, child_id);
}

EMSCRIPTEN_KEEPALIVE
void set_cpt(const char* node_id, const float* probs, int length) {
    std::vector<float> cpt(probs, probs + length);
    global_net.set_cpt(node_id, cpt);
}

EMSCRIPTEN_KEEPALIVE
void set_evidence(const char* node_id, int state_index) {
    if (state_index < 0) {
        auto node = global_net.get_node(node_id);
        if (node) node->clear_evidence();
    } else {
        global_net.set_evidence(node_id, state_index);
    }
}

EMSCRIPTEN_KEEPALIVE
void clear_all_evidence() {
    global_net.clear_evidence();
}

// Since WASM can't easily return vectors, we pass in a pre-allocated pointer from JS
EMSCRIPTEN_KEEPALIVE
void get_marginals(const char* node_id, float* out_buffer, int max_length) {
    std::vector<float> marginals = global_net.infer_marginals(node_id);
    int limit = std::min((int)marginals.size(), max_length);
    for (int i = 0; i < limit; ++i) {
        out_buffer[i] = marginals[i];
    }
}

} // extern "C"

// A simple local main for testing natively if compiled without emscripten
#ifndef __EMSCRIPTEN__
int main() {
    std::cout << "Local test of the BayesNet library." << std::endl;
    std::cout << "Creating Burglary -> Alarm network..." << std::endl;
    
    global_net.add_node("Burglary", {"True", "False"});
    global_net.add_node("Alarm", {"True", "False"});
    global_net.add_edge("Burglary", "Alarm");
    
    // P(Burglary) = 0.01
    global_net.set_cpt("Burglary", {0.01f, 0.99f});
    
    // P(Alarm | Burglary=True) = 0.95, P(Alarm | Burglary=False) = 0.05
    // Order: [Alarm=T | Burg=T], [Alarm=F | Burg=T], [Alarm=T | Burg=F], [Alarm=F | Burg=F]
    global_net.set_cpt("Alarm", {0.95f, 0.05f, 0.05f, 0.95f});
    
    auto m_alarm = global_net.infer_marginals("Alarm");
    std::cout << "P(Alarm=True) without evidence: " << m_alarm[0] << std::endl;
    
    global_net.set_evidence("Burglary", 0); // Observed Burglary = True
    auto m_alarm_ev = global_net.infer_marginals("Alarm");
    std::cout << "P(Alarm=True | Burglary=True): " << m_alarm_ev[0] << std::endl;

    return 0;
}
#endif
