#ifndef BAYESNET_HPP
#define BAYESNET_HPP

#include "Node.hpp"
#include <unordered_map>
#include <vector>
#include <string>
#include <memory>
#include <cmath>
#include <stdexcept>
#include <algorithm>

namespace bayes {

// BayesNet represents a DAG of Node objects and performs Exact Inference.
// We use C++11 std::shared_ptr to manage the graph nodes and C++17 structured bindings.

class BayesNet {
public:
    BayesNet() = default;

    // Create a new node in the network and return a weak pointer to it.
    std::weak_ptr<Node> add_node(const std::string& id, const std::vector<std::string>& states) {
        if (nodes_.find(id) != nodes_.end()) {
            throw std::invalid_argument("Node with ID already exists: " + id);
        }
        
        auto node = std::make_shared<Node>(id, states);
        nodes_[id] = node;
        node_order_.push_back(node); // Keep track of insertion order for the joint distribution
        return node;
    }

    // Add a directed edge from parent_id to child_id
    void add_edge(const std::string& parent_id, const std::string& child_id) {
        auto parent = get_node(parent_id);
        auto child = get_node(child_id);
        
        if (!parent || !child) {
            throw std::invalid_argument("Invalid node IDs for edge creation.");
        }
        
        child->add_parent(parent);
    }
    
    // Set the CPT for a particular node
    void set_cpt(const std::string& node_id, std::vector<float> cpt) {
        if (auto node = get_node(node_id)) {
            node->set_cpt(std::move(cpt));
        }
    }

    // Set observed evidence
    void set_evidence(const std::string& node_id, std::size_t state_index) {
        if (auto node = get_node(node_id)) {
            node->set_evidence(state_index);
        }
    }
    
    void clear_evidence() {
        for (const auto& [id, node] : nodes_) {
            node->clear_evidence();
        }
    }

    // Completely destroys the graph, clearing all memory
    void clear_network() {
        nodes_.clear();
        node_order_.clear();
    }

    // Get a specific node
    std::shared_ptr<Node> get_node(const std::string& id) const {
        auto it = nodes_.find(id);
        if (it != nodes_.end()) {
            return it->second;
        }
        return nullptr;
    }

    // Exact Inference Algorithm (Variable Elimination / Marginalization via Joint Distribution)
    // Warning: This explicitly builds the full Joint Probability Distribution.
    // Complexity is O(2^N). For educational / small network purposes, this is ideal.
    std::vector<float> infer_marginals(const std::string& query_id) const {
        auto query_node = get_node(query_id);
        if (!query_node) {
            throw std::invalid_argument("Unknown query node: " + query_id);
        }

        std::size_t n_states = query_node->num_states();
        std::vector<float> marginals(n_states, 0.0f);
        
        // Total number of possible assignments to the joint distribution (prod of all states)
        std::size_t total_assignments = 1;
        std::vector<std::size_t> strides(node_order_.size(), 1);
        
        for (std::size_t i = 0; i < node_order_.size(); ++i) {
            if (i > 0) {
                strides[i] = strides[i-1] * node_order_[i-1]->num_states();
            }
            total_assignments *= node_order_[i]->num_states();
        }
        
        // 1. Calculate joint probability for each assignment
        // 2. Sum up the probabilities where the assignment matches evidence
        float total_prob = 0.0f; // For normalization
        
        for (std::size_t a = 0; a < total_assignments; ++a) {
            // Extract the state index for each node in this assignment
            std::vector<std::size_t> assignment(node_order_.size());
            bool matches_evidence = true;
            
            for (std::size_t i = 0; i < node_order_.size(); ++i) {
                assignment[i] = (a / strides[i]) % node_order_[i]->num_states();
                
                // If evidence is set on this node and it contradicts this assignment, skip.
                if (node_order_[i]->has_evidence() && node_order_[i]->get_evidence() != assignment[i]) {
                    matches_evidence = false;
                    break;
                }
            }
            
            if (!matches_evidence) continue;
            
            // Calculate P(Assignment) = Product_i P(Node_i | Parents_i)
            float p_assignment = 1.0f;
            
            for (std::size_t i = 0; i < node_order_.size(); ++i) {
                auto& node = node_order_[i];
                
                // Find the index into the node's CPT based on its parents' states in `assignment`
                std::size_t cpt_index = assignment[i];
                std::size_t multiplier = node->num_states();
                
                for (const auto& w_parent : node->parents()) {
                    if (auto parent = w_parent.lock()) {
                        // Find the index of the parent in our order
                        auto p_it = std::find(node_order_.begin(), node_order_.end(), parent);
                        std::size_t p_idx = std::distance(node_order_.begin(), p_it);
                        
                        cpt_index += assignment[p_idx] * multiplier;
                        multiplier *= parent->num_states();
                    }
                }
                
                p_assignment *= node->cpt()[cpt_index];
                
                // Short circuit if 0
                if (p_assignment == 0.0f) break; 
            }
            
            // Accumulate marginals for the query node
            if (p_assignment > 0.0f) {
                auto query_it = std::find(node_order_.begin(), node_order_.end(), query_node);
                std::size_t query_idx = std::distance(node_order_.begin(), query_it);
                
                marginals[assignment[query_idx]] += p_assignment;
                total_prob += p_assignment;
            }
        }
        
        // Normalize the marginal probabilities
        if (total_prob > 0.0f) {
            for (auto& prob : marginals) {
                prob /= total_prob;
            }
        }
        
        return marginals;
    }

private:
    std::unordered_map<std::string, std::shared_ptr<Node>> nodes_;
    
    // Keep a deterministic order of nodes for building the joint distribution assignment
    std::vector<std::shared_ptr<Node>> node_order_;
};

} // namespace bayes

#endif // BAYESNET_HPP
