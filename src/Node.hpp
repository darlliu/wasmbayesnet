#ifndef NODE_HPP
#define NODE_HPP

#include <string>
#include <vector>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>

namespace bayes {

// Node represents a random variable in a Bayesian Network graph.
// We use `std::shared_ptr` to manage the lifecycle of Nodes, and 
// `std::weak_ptr` for parents/children to prevent cyclic memory leaks.
// For the learning goal, we utilize C++20 `std::span` for array passing
// and C++17 `std::optional` for evidence states.

class Node : public std::enable_shared_from_this<Node> {
public:
    // A node has an ID (name) and a list of mutually exclusive states (e.g., {"True", "False"})
    Node(std::string id, std::vector<std::string> states) 
        : id_(std::move(id)), states_(std::move(states)) {}

    // No copying - nodes are unique entities in a graph.
    Node(const Node&) = delete;
    Node& operator=(const Node&) = delete;

    // Moving is fine.
    Node(Node&&) = default;
    Node& operator=(Node&&) = default;

    const std::string& id() const { return id_; }
    const std::vector<std::string>& states() const { return states_; }
    std::size_t num_states() const { return states_.size(); }

    // --- Graph Topology ---
    
    // Add a parent node. C++11 shared_ptr ensures robust graphs.
    void add_parent(std::shared_ptr<Node> parent) {
        parents_.push_back(parent);
    }
    
    // Using std::span (C++20) returns a read-only view over the parents vector 
    // without the overhead of copying or exposing the internal vector fully.
    std::span<const std::weak_ptr<Node>> parents() const {
        return parents_;
    }

    // --- Probabilities ---

    // The CPT size must be (num_states of this node) * (product of num_states of all parents)
    std::size_t expected_cpt_size() const {
        std::size_t size = num_states();
        for (const auto& w_parent : parents_) {
            if (auto p = w_parent.lock()) { // Lock the weak_ptr
                size *= p->num_states();
            }
        }
        return size;
    }

    // Set the Conditional Probability Table. 
    // Passes the probabilities by value so we can move it into our member.
    void set_cpt(std::vector<float> probabilities) {
        if (probabilities.size() != expected_cpt_size()) {
            throw std::invalid_argument("CPT size does not match network topology for node: " + id_);
        }
        cpt_ = std::move(probabilities);
    }

    const std::vector<float>& cpt() const { return cpt_; }

    // --- Evidence ---

    // C++17 std::optional replaces the concept of "null" or "-1" for observed states.
    // E.g., if observed as "True", evidence_ = 0. If unknown, evidence_ = std::nullopt.
    void set_evidence(std::size_t state_index) {
        if (state_index >= num_states()) {
            throw std::out_of_range("Invalid state index for evidence on node: " + id_);
        }
        evidence_ = state_index;
    }

    void clear_evidence() {
        evidence_ = std::nullopt;
    }

    bool has_evidence() const { return evidence_.has_value(); }
    std::size_t get_evidence() const { return evidence_.value(); }

private:
    std::string id_;
    std::vector<std::string> states_;
    
    // Edges are directed. Parents are weak_ptrs to avoid cyclic reference memory leaks 
    // if the user somehow wires an accidental cycle (though Bayes Nets must be DAGs).
    std::vector<std::weak_ptr<Node>> parents_;
    
    // 1D array representing the N-dimensional Conditional Probability Table.
    // Order: The fastest changing index is this Node's state, then the last parent, 
    // up to the first parent.
    std::vector<float> cpt_;

    // Optional evidence (whether this variable's state has been explicitly observed)
    std::optional<std::size_t> evidence_{std::nullopt};
};

} // namespace bayes

#endif // NODE_HPP
