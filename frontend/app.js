// app.js

// --- Global Application State ---
let BEngine = null; // The WebAssembly module instance
let nodes = [];
let links = [];
let selectedNode = null;
let nodeCounter = 0;

// Edge Linking State
let isLinkingMode = false;
let linkingSourceNode = null;

// --- D3 Canvas Setup ---
const svg = d3.select("#network-canvas");
const width = svg.node().clientWidth;
const height = svg.node().clientHeight;

const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(200))
    .force("charge", d3.forceManyBody().strength(-150))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius(50));

// Arrow definition for edges
svg.append("defs").append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 25)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("class", "link-marker");

const linkGroup = svg.append("g").attr("class", "links");
const nodeGroup = svg.append("g").attr("class", "nodes");

let linkElements = linkGroup.selectAll(".link");
let nodeElements = nodeGroup.selectAll(".node");

// --- Initialization & WASM Bootstrapping ---

async function init() {
    try {
        // Module is provided globally by Emscripten's engine.js
        BEngine = await Module();

        document.getElementById('wasm-indicator').className = 'indicator ready';
        document.getElementById('wasm-text').textContent = 'WASM Engine Ready';

        setupEventListeners();

        // Theme Toggle Setup
        const themeSelector = document.getElementById('theme-selector');
        if (themeSelector) {
            themeSelector.addEventListener('change', (e) => {
                document.body.dataset.theme = e.target.value;
            });
        }

        // Add a demo network automatically
        createDemoNetwork();

    } catch (e) {
        console.error("WASM Load Error", e);
        document.getElementById('wasm-indicator').className = 'indicator error';
        document.getElementById('wasm-text').textContent = 'WASM Failed to Load';
    }
}

// --- Demo Builder ---
function createDemoNetwork() {
    // 1. Create nodes in UI and WASM
    const idA = addNodeToApp("Weather", width / 2, height / 2 - 100, 'complex', ["Sunny", "Rainy", "Foggy"]);
    const idB = addNodeToApp("Murder", width / 2, height / 2 + 100, 'basic', ["True", "False"]);

    // 2. Link them
    addLink(idA, idB);

    // 3. Set CPTs in WASM and UI App State
    // Weather (Prior): 60% Sunny, 30% Rainy, 10% Foggy
    setCptApp(idA, [0.6, 0.3, 0.1]);

    // Murder | Weather. Order matches C++ traversal: [M_S0|W_S0], [M_S1|W_S0], [M_S0|W_S1], [M_S1|W_S1], [M_S0|W_S2], [M_S1|W_S2]
    // Sunny -> Murder true is 5%. Rainy -> Murder true is 30%. Foggy -> Murder true is 80%.
    // State 0 = True, State 1 = False.
    setCptApp(idB, [
        0.05, 0.95, // W = Sunny
        0.30, 0.70, // W = Rainy
        0.80, 0.20  // W = Foggy
    ]);

    // Explicitly set the link type for the demo
    const demoLink = links.find(l => l.source.id === idA && l.target.id === idB);
    if (demoLink) demoLink.type = 'neutral';

    recalculateAll();
}

function setCptApp(nodeId, probArray) {
    const node = nodes.find(n => n.id === nodeId);
    if (node) node.customCPT = probArray;
    setCptWasm(nodeId, probArray);
}

// --- WASM Interface Wrappers ---

function addNodeToWasm(id, numStates) {
    if (!BEngine) return;
    BEngine.ccall('create_node', 'void', ['string', 'number'], [id, numStates]);
}

function addEdgeToWasm(parentId, childId) {
    if (!BEngine) return;
    BEngine.ccall('add_edge', 'void', ['string', 'string'], [parentId, childId]);
}

function setCptWasm(nodeId, probArray) {
    if (!BEngine) return;
    const bytesPerElement = 4; // float32
    const _malloc = BEngine._malloc || BEngine.malloc || (size => BEngine.ccall('malloc', 'number', ['number'], [size]));
    const _free = BEngine._free || BEngine.free || (ptr => BEngine.ccall('free', 'void', ['number'], [ptr]));

    const ptr = _malloc(probArray.length * bytesPerElement);

    // Robustly set values without touching native HEAP memory arrays
    for (let i = 0; i < probArray.length; i++) {
        BEngine.setValue(ptr + i * bytesPerElement, probArray[i], 'float');
    }

    BEngine.ccall('set_cpt', 'void', ['string', 'number', 'number'], [nodeId, ptr, probArray.length]);
    _free(ptr);
}

function setEvidenceWasm(nodeId, stateIndex) {
    if (!BEngine) return;
    BEngine.ccall('set_evidence', 'void', ['string', 'number'], [nodeId, stateIndex]);
}

function setEvidenceApp(nodeId, stateIndex) {
    if (!BEngine) return;
    const node = nodes.find(n => n.id === nodeId);
    if (node) node.evidence = stateIndex;
    setEvidenceWasm(nodeId, stateIndex);
}

function clearNetworkApp() {
    if (!BEngine) return;
    nodes = [];
    links = [];
    nodeCounter = 0;
    selectedNode = null;
    BEngine.ccall('clear_network', 'void', [], []);
    const panel = document.getElementById('properties-panel');
    if (panel) panel.classList.add('hidden');
    updateGraph();
}

function clearAllEvidenceApp() {
    if (!BEngine) return;
    nodes.forEach(n => n.evidence = -1);
    BEngine.ccall('clear_all_evidence', 'void', [], []);
    updateGraph();
}

function getMarginalsWasm(nodeId) {
    if (!BEngine) return [];

    // Need to know how many states to fetch
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return [];
    const numStates = node.states.length;
    const bytesPerElement = 4; // float32 size

    const _malloc = BEngine._malloc || BEngine.malloc || (size => BEngine.ccall('malloc', 'number', ['number'], [size]));
    const _free = BEngine._free || BEngine.free || (ptr => BEngine.ccall('free', 'void', ['number'], [ptr]));

    const ptr = _malloc(numStates * bytesPerElement);
    BEngine.ccall('get_marginals', 'void', ['string', 'number', 'number'], [nodeId, ptr, numStates]);

    // Robustly read float data without touching native HEAP arrays
    const output = [];
    for (let i = 0; i < numStates; i++) {
        output.push(BEngine.getValue(ptr + i * bytesPerElement, 'float'));
    }

    _free(ptr);
    return output;
}

// --- Core App Logic ---

function addNodeToApp(name, x, y, type = 'basic', states = ["True", "False"]) {
    const id = "N" + (++nodeCounter);
    const label = name || id;

    // edgeCPTs maps parentId -> array of conditional probabilities given that parent's states.
    // fullCustomCPT is for the advanced matrix if they override independence.
    const newNode = { id, label, x, y, evidence: -1, type, states, edgeCPTs: {}, fullCustomCPT: null };
    nodes.push(newNode);

    addNodeToWasm(id, states.length);

    updateGraph();
    return id;
}

// Helper to get all parent state combinations
function getParentStateCombinations(parentLinks) {
    if (parentLinks.length === 0) {
        return [[]]; // No parents, one combination (empty)
    }

    const parentStates = parentLinks.map(l => l.source.states);
    const combinations = [];

    function generateCombinations(index, currentCombination) {
        if (index === parentStates.length) {
            combinations.push(currentCombination);
            return;
        }

        for (let i = 0; i < parentStates[index].length; i++) {
            generateCombinations(index + 1, currentCombination.concat({
                parent: parentLinks[index].source,
                stateIndex: i,
                stateName: parentStates[index][i]
            }));
        }
    }

    generateCombinations(0, []);
    return combinations;
}

// Builds the full joint matrix from independent edge CPTs (ICI model)
function autoGenerateJointCPT(node) {
    if (node.fullCustomCPT) {
        // If they saved an advanced matrix, override ICI
        setCptApp(node.id, node.fullCustomCPT);
        return;
    }

    const parentLinks = links.filter(l => l.target.id === node.id);
    const childNumStates = node.states.length;
    const jointCpt = [];

    const parentCombinations = getParentStateCombinations(parentLinks);

    parentCombinations.forEach(combo => {
        // Initialize with default uniform probabilities
        let rowProbs = Array(childNumStates).fill(1.0);
        let validParents = 0;

        combo.forEach(parentState => {
            const pid = parentState.parent.id;
            const sIdx = parentState.stateIndex;

            // Look up independent edge math for this parent
            if (node.edgeCPTs && node.edgeCPTs[pid]) {
                const independentProbs = node.edgeCPTs[pid][sIdx];
                if (independentProbs) {
                    for (let i = 0; i < childNumStates; i++) {
                        rowProbs[i] *= independentProbs[i];
                    }
                    validParents++;
                }
            }
        });

        // Normalize the combined row
        let sum = rowProbs.reduce((a, b) => a + b, 0);
        if (sum === 0 || validParents === 0) {
            // Fallback uniform if zero or no rules defined
            rowProbs = Array(childNumStates).fill(1.0 / childNumStates);
        } else {
            rowProbs = rowProbs.map(p => p / sum);
        }

        rowProbs.forEach(p => jointCpt.push(p));
    });

    node.customCPT = jointCpt;
    setCptApp(node.id, jointCpt);
}

function addLink(sourceId, targetId) {
    const sourceNode = nodes.find(n => n.id === sourceId);
    const targetNode = nodes.find(n => n.id === targetId);

    if (sourceNode && targetNode && sourceId !== targetId) {
        // Prevent dupes
        if (!links.some(l => l.source.id === sourceId && l.target.id === targetId)) {
            links.push({ source: sourceNode, target: targetNode, type: 'infers' });
            addEdgeToWasm(sourceId, targetId);
            autoGenerateJointCPT(targetNode);
            recalculateAll();
            updateGraph();
        }
    }
}

function recalculateAll() {
    if (!BEngine) return;
    nodes.forEach(n => {
        n.marginals = getMarginalsWasm(n.id);
    });

    // Update active UI
    if (selectedNode) {
        updatePropertiesPanel(selectedNode);
    }
}

// --- D3 Rendering ---

function updateGraph() {
    // Links
    linkElements = linkElements.data(links, d => d.source.id + "-" + d.target.id);
    linkElements.exit().remove();

    const linkEnter = linkElements.enter().append("path")
        .attr("class", d => `link edge-${d.type}`)
        .attr("marker-end", "url(#arrowhead)")
        .style("cursor", "pointer")
        .on("click", (event, d) => {
            // When clicking an edge, select the child node
            selectNode(d.target);
            // Highlight the specific parent row in the properties panel
            setTimeout(() => {
                const row = document.getElementById(`parent-row-${d.source.id}`);
                if (row) {
                    row.style.backgroundColor = "rgba(59, 130, 246, 0.2)";
                    setTimeout(() => row.style.backgroundColor = "transparent", 1000);
                }
            }, 50);
        });

    linkElements = linkEnter.merge(linkElements);
    linkElements.attr("class", d => `link edge-${d.type}`);

    // Nodes
    nodeElements = nodeElements.data(nodes, d => d.id);
    nodeElements.exit().remove();

    const nodeEnter = nodeElements.enter().append("g")
        .attr("class", "node")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended))
        .on("click", (event, d) => selectNode(d))
        .on("dblclick", (event, d) => {
            const newName = prompt("Enter new name for node:", d.label);
            if (newName && newName.trim() !== "") {
                d.label = newName.trim();
                updateGraph();
                if (selectedNode && selectedNode.id === d.id) {
                    document.getElementById('edit-node-name').value = d.label;
                }
            }
        });

    nodeEnter.append("circle")
        .attr("r", 30)
        .attr("display", d => d.type === 'basic' ? null : "none");

    nodeEnter.append("rect")
        .attr("width", 80)
        .attr("height", 40)
        .attr("x", -40)
        .attr("y", -20)
        .attr("display", d => d.type === 'complex' ? null : "none");

    nodeEnter.append("text")
        .attr("dy", d => d.type === 'basic' ? ".35em" : "-5px")
        .attr("text-anchor", "middle")
        .text(d => d.label);

    nodeEnter.append("text")
        .attr("class", "subtext")
        .attr("dy", "15px")
        .attr("text-anchor", "middle")
        .attr("font-size", "10px")
        .attr("fill", "var(--text-muted)")
        .attr("display", d => d.type === 'complex' ? null : "none")
        .text(d => d.states.length + " states");

    nodeElements = nodeEnter.merge(nodeElements);

    // Update texts dynamically on rename
    nodeElements.select("text").text(d => d.label);

    // Rebind CSS classes based on state
    nodeElements.attr("class", d => {
        let cls = "node " + d.type;
        if (selectedNode && d.id === selectedNode.id) cls += " selected";
        if (linkingSourceNode && d.id === linkingSourceNode.id) cls += " linking-source";
        if (d.evidence !== -1) cls += " evidence-set";
        return cls;
    });

    simulation.nodes(nodes);
    simulation.force("link").links(links);
    simulation.alpha(1).restart();
}

function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
}

function dragged(event, d) {
    d.fx = event.x; d.fy = event.y;
}

function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null; d.fy = null;
}

simulation.on("tick", () => {
    // Constrain nodes within bounds
    const radius = 30;
    nodes.forEach(d => {
        d.x = Math.max(radius, Math.min(width - radius, d.x));
        d.y = Math.max(radius, Math.min(height - radius, d.y));
    });

    linkElements.attr("d", d => {
        const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
        const dr = Math.sqrt(dx * dx + dy * dy) * 1.5; // Curved edges
        return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
    });
    nodeElements.attr("transform", d => `translate(${d.x},${d.y})`);
});

// --- UI Interactions ---

function selectNode(d) {
    if (isLinkingMode) {
        if (!linkingSourceNode) {
            linkingSourceNode = d;
            updateGraph(); // Highlight source
        } else if (linkingSourceNode.id !== d.id) {
            addLink(linkingSourceNode.id, d.id);
            // Reset linking mode
            isLinkingMode = false;
            linkingSourceNode = null;
            const btnAddEdge = document.getElementById('btn-add-edge');
            if (btnAddEdge) {
                btnAddEdge.classList.remove('active');
                btnAddEdge.textContent = 'Add Edge';
            }
            svg.classed('linking-mode', false);
            updateGraph();
        }
        return; // Don't open properties panel in linking mode
    }

    selectedNode = d;
    updateGraph(); // trigger highlighting

    document.getElementById('panel-empty').classList.add('hidden');
    document.getElementById('panel-editor').classList.remove('hidden');
    document.getElementById('properties-panel').classList.remove('hidden');

    updatePropertiesPanel(d);
}

// Helper to build a cascading slider group for a target node and a specific parent state
function buildCascadingSliders(targetNode, parentId, parentStateIndex, labelText) {
    const container = document.createElement('div');
    container.style.marginTop = "10px";
    container.style.paddingLeft = "10px";
    container.style.borderLeft = "2px solid rgba(255,255,255,0.1)";

    const label = document.createElement('div');
    label.style.fontSize = "0.85rem";
    label.style.color = "var(--text-muted)";
    label.textContent = labelText;
    container.appendChild(label);

    // Initialize edgeCPT array if undefined
    if (!targetNode.edgeCPTs[parentId]) targetNode.edgeCPTs[parentId] = [];
    if (!targetNode.edgeCPTs[parentId][parentStateIndex]) {
        targetNode.edgeCPTs[parentId][parentStateIndex] = Array(targetNode.states.length).fill(1.0 / targetNode.states.length);
    }
    const probs = targetNode.edgeCPTs[parentId][parentStateIndex];

    const sliders = [];
    const valDisplays = [];

    targetNode.states.forEach((childState, cIdx) => {
        // Single slider logic for binary nodes
        if (targetNode.states.length === 2 && cIdx === 0) {
            const row = document.createElement('div');
            row.className = "slider-container";

            const numInput = document.createElement('input');
            numInput.type = 'number';
            numInput.min = '0';
            numInput.max = '1';
            numInput.step = '0.01';
            numInput.value = probs[0].toFixed(2);
            numInput.style.width = "70px";
            numInput.style.textAlign = "center";
            numInput.style.background = "rgba(0,0,0,0.3)";
            numInput.style.color = "white";
            numInput.style.border = "1px solid var(--border-color)";
            numInput.style.borderRadius = "4px";
            numInput.style.padding = "4px";
            numInput.style.margin = "0 10px";

            const sLabelRight = document.createElement('div');
            sLabelRight.className = "slider-label";
            sLabelRight.textContent = targetNode.states[0]; // T on right
            sLabelRight.style.transition = "all 0.1s ease";
            sLabelRight.style.display = "inline-block";

            const updateLabelVisual = (val) => {
                // Dimmer base at 0, bright neon blue/cyan at 1
                const baseOpacity = 0.3 + (val * 0.7);
                sLabelRight.style.color = `rgba(0, 180, 255, ${baseOpacity})`;
                sLabelRight.style.textShadow = `0 0 ${val * 12}px rgba(0, 180, 255, ${val})`;
                sLabelRight.style.fontWeight = val > 0.5 ? "bold" : "normal";
                sLabelRight.style.transform = `scale(${1 + val * 0.15})`;
            };

            // Init visually
            updateLabelVisual(probs[0]);

            numInput.addEventListener('input', (e) => {
                let val = parseFloat(e.target.value);
                if (isNaN(val)) return;

                if (val > 1.0) val = 1.0;
                if (val < 0.0) val = 0.0;

                probs[0] = val;
                probs[1] = 1.0 - val;

                updateLabelVisual(val);

                targetNode.fullCustomCPT = null;
                autoGenerateJointCPT(targetNode);
                recalculateAll();
                updatePropertiesPanel(targetNode, true);
            });

            // Prevent DOM destruction specifically here 
            // since we don't want to lose focus while typing numbers
            numInput.addEventListener('change', (e) => {
                let val = parseFloat(e.target.value);
                if (isNaN(val)) {
                    val = 0.0;
                }
                e.target.value = val.toFixed(2);
            });

            // Force alignment row center
            row.style.justifyContent = "center";
            row.style.alignItems = "center";
            row.style.gap = "15px";

            row.appendChild(numInput);
            row.appendChild(sLabelRight);
            container.appendChild(row);
        }
        else if (targetNode.states.length > 2) {
            // Complex node cascading logic
            const row = document.createElement('div');
            row.className = "slider-container";

            const sLabel = document.createElement('div');
            sLabel.className = "slider-label";
            sLabel.textContent = childState;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '1';
            slider.step = '0.005';
            let initialVal = Math.max(0.005, Math.min(0.995, probs[cIdx]));
            slider.value = initialVal;
            slider.style.cursor = "pointer";
            slider.style.pointerEvents = "auto";
            slider.style.setProperty('--val', `${initialVal * 100}%`);

            const sVal = document.createElement('div');
            sVal.className = "slider-value";
            sVal.textContent = probs[cIdx].toFixed(2);

            if (cIdx === targetNode.states.length - 1) {
                slider.disabled = true;
                slider.style.opacity = '0.5';
            }

            slider.addEventListener('input', (e) => {
                let val = parseFloat(e.target.value);

                // Prevent locking the slider down by leaving a tiny epsilon if it hits 1.0 
                // but other sliders exist (to allow dragging them back up)
                if (val > 0.999) val = 0.999;
                if (val < 0.001) val = 0.001;

                let oldVal = probs[cIdx];
                probs[cIdx] = val;

                // We need to distribute the remaining probability (1.0 - val) 
                // proportionately among all OTHER states based on their current relative weights.
                let remainderToDistribute = 1.0 - val;

                // Calculate the total probability currently held by the *other* states
                let sumOther = 0;
                for (let i = 0; i < targetNode.states.length; i++) {
                    if (i !== cIdx) sumOther += probs[i];
                }

                if (sumOther <= 0.0001) {
                    // Edge case: all other sliders had 0 probability. Distribute evenly.
                    let evenSplit = remainderToDistribute / (targetNode.states.length - 1);
                    for (let i = 0; i < targetNode.states.length; i++) {
                        if (i !== cIdx) probs[i] = evenSplit;
                    }
                } else {
                    // Normal case: scale existing probabilities proportionately
                    let scaleFactor = remainderToDistribute / sumOther;
                    for (let i = 0; i < targetNode.states.length; i++) {
                        if (i !== cIdx) {
                            probs[i] = probs[i] * scaleFactor;
                        }
                    }
                }

                // Force exact sum to 1.0 by dumping any floating point remainder into the last available slider
                let finalSum = 0;
                let lastValidIdx = targetNode.states.length - 1;
                if (cIdx === lastValidIdx) lastValidIdx = targetNode.states.length - 2;

                for (let i = 0; i < targetNode.states.length; i++) {
                    if (i !== lastValidIdx) finalSum += probs[i];
                }
                probs[lastValidIdx] = 1.0 - finalSum;

                // Sync OTHER sliders with fresh visual updates
                for (let i = 0; i < targetNode.states.length; i++) {
                    if (sliders[i]) {
                        let clampV = Math.max(0.005, Math.min(0.995, probs[i]));

                        // Extremely important: Do NOT overwrite the value of the active slider!
                        if (i !== cIdx) {
                            sliders[i].value = clampV;
                        }

                        sliders[i].style.setProperty('--val', `${clampV * 100}%`);
                        valDisplays[i].textContent = probs[i].toFixed(2);
                    }
                }

                targetNode.fullCustomCPT = null;
                autoGenerateJointCPT(targetNode);
                recalculateAll();
                updatePropertiesPanel(targetNode, true);
            });

            sliders.push(slider);
            valDisplays.push(sVal);

            row.appendChild(sLabel);
            row.appendChild(slider);
            row.appendChild(sVal);
            container.appendChild(row);
        }
    });

    return container;
}

function updatePropertiesPanel(d, skipCptRender = false) {
    document.getElementById('edit-node-name').value = d.label;

    // Build incoming dependencies list
    const parentLinks = links.filter(l => l.target.id === d.id);
    const parentsCol = document.getElementById('parents-section');
    const parentsList = document.getElementById('parents-list');

    if (!skipCptRender) {
        if (parentLinks.length > 0) {
            parentsCol.style.display = 'block';
            parentsList.innerHTML = '';
            parentLinks.forEach(l => {
                const row = document.createElement('div');
                row.className = 'parent-row';
                row.id = `parent-row-${l.source.id}`;
                row.style.transition = 'background-color 0.5s';
                row.style.padding = '10px 0';
                row.style.borderBottom = '1px solid var(--border-color)';

                const headerWrapper = document.createElement('div');
                headerWrapper.style.display = 'flex';
                headerWrapper.style.justifyContent = 'space-between';
                headerWrapper.style.alignItems = 'center';

                headerWrapper.innerHTML = `<span style="font-weight: bold; color: var(--accent);">${l.source.label}</span>`;

                // Simple Logic applicable?
                let isSimpleLogic = d.type === 'basic' && l.source.type === 'basic';

                if (isSimpleLogic) {
                    const selectHtml = document.createElement('select');
                    selectHtml.innerHTML = `
                        <option value="infers" ${l.type === 'infers' ? 'selected' : ''}>Infers</option>
                        <option value="negates" ${l.type === 'negates' ? 'selected' : ''}>Negates</option>
                        <option value="neutral" ${l.type === 'neutral' ? 'selected' : ''}>Neutral</option>
                    `;
                    selectHtml.addEventListener('change', (e) => {
                        l.type = e.target.value;

                        // Automatically update edgeCPT thresholds based on Logic type
                        if (!d.edgeCPTs[l.source.id]) d.edgeCPTs[l.source.id] = [[], []];
                        if (l.type === 'infers') {
                            d.edgeCPTs[l.source.id][0] = [0.9, 0.1]; // P(C|P=T)
                            d.edgeCPTs[l.source.id][1] = [0.1, 0.9]; // P(C|P=F)
                        } else if (l.type === 'negates') {
                            d.edgeCPTs[l.source.id][0] = [0.1, 0.9];
                            d.edgeCPTs[l.source.id][1] = [0.9, 0.1];
                        } else {
                            d.edgeCPTs[l.source.id][0] = [0.5, 0.5];
                            d.edgeCPTs[l.source.id][1] = [0.5, 0.5];
                        }
                        d.fullCustomCPT = null;
                        autoGenerateJointCPT(d);
                        recalculateAll();
                        updateGraph();
                        updatePropertiesPanel(d); // full re-render
                    });
                    headerWrapper.appendChild(selectHtml);
                } else {
                    l.type = 'neutral';
                    // Don't override complex properties explicitly here, just let sliders handle it
                }
                row.appendChild(headerWrapper);

                // Sliders for P(Child | Parent=State)
                const sliderWrapper = document.createElement('div');
                sliderWrapper.style.display = 'flex';
                sliderWrapper.style.flexDirection = 'column'; // Stack sliders vertically to ensure full width
                sliderWrapper.style.gap = '10px';

                l.source.states.forEach((pState, sIdx) => {
                    const sContainer = buildCascadingSliders(d, l.source.id, sIdx, `When ${l.source.label} is ${pState}:`);
                    sContainer.style.flex = "1 1 auto"; // Allow them to grow and wrap 
                    sliderWrapper.appendChild(sContainer);
                });

                row.appendChild(sliderWrapper);

                parentsList.appendChild(row);
            });
        } else {
            parentsCol.style.display = 'none';
            parentsList.innerHTML = '';

            // Root node needs prior sliders!
            const priorContainer = buildCascadingSliders(d, 'prior', 0, `Base Prior Probability (No Parents):`);
            parentsCol.style.display = 'block';
            parentsList.appendChild(priorContainer);
        }
    }

    // Auto Gen init if missing
    if (!d.customCPT) autoGenerateJointCPT(d);

    // Dynamic Evidence buttons
    const evControls = document.getElementById('evidence-controls');
    evControls.innerHTML = '';

    const unkBtn = document.createElement('button');
    unkBtn.className = `toggle-btn ${d.evidence === -1 ? 'active' : ''}`;
    unkBtn.setAttribute('data-state', 'none');
    unkBtn.textContent = 'Unknown';
    evControls.appendChild(unkBtn);

    d.states.forEach((stateName, idx) => {
        const btn = document.createElement('button');
        btn.className = `toggle-btn ${d.evidence === idx ? 'active' : ''}`;
        btn.setAttribute('data-state', idx.toString());
        btn.textContent = stateName;
        evControls.appendChild(btn);
    });

    // Bind click events directly rather than globally to avoid stale closures
    evControls.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (!selectedNode) return;
            const state = e.target.getAttribute('data-state');

            evControls.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            if (state === "none") {
                selectedNode.evidence = -1;
            } else {
                selectedNode.evidence = parseInt(state);
            }

            setEvidenceWasm(selectedNode.id, selectedNode.evidence);
            recalculateAll();
            updateGraph();
        });
    });

    // Dynamic Marginals
    const margContainer = document.getElementById('marginals-container');
    margContainer.innerHTML = '';
    if (d.marginals && d.marginals.length === d.states.length) {
        d.states.forEach((stateName, idx) => {
            const pVal = (d.marginals[idx] * 100).toFixed(1);
            const colorClass = `color-${idx % 6}`;

            const html = `
                <div class="progress-bar-container">
                    <div class="progress-label">
                        <span>${stateName}</span>
                        <span>${pVal}%</span>
                    </div>
                    <div class="progress-track">
                        <div class="progress-fill ${colorClass}" style="width: ${pVal}%"></div>
                    </div>
                </div>
            `;
            margContainer.innerHTML += html;
        });
    }
}

function setupEventListeners() {
    document.getElementById('btn-add-basic-node').addEventListener('click', () => {
        addNodeToApp("New Binary", width / 2, height / 2, 'basic', ["True", "False"]);
    });

    document.getElementById('btn-add-complex-node').addEventListener('click', () => {
        document.getElementById('complex-states-input').value = "Sunny, Rainy, Foggy";
        document.getElementById('add-complex-modal').classList.remove('hidden');
        document.getElementById('complex-states-input').focus();
    });

    document.getElementById('btn-close-complex-modal').addEventListener('click', () => {
        document.getElementById('add-complex-modal').classList.add('hidden');
    });

    document.getElementById('btn-cancel-complex-modal').addEventListener('click', () => {
        document.getElementById('add-complex-modal').classList.add('hidden');
    });

    document.getElementById('btn-confirm-complex-modal').addEventListener('click', () => {
        const stateStr = document.getElementById('complex-states-input').value;
        if (stateStr) {
            const states = stateStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
            if (states.length > 0) {
                addNodeToApp("New Complex", width / 2, height / 2, 'complex', states);
            }
        }
        document.getElementById('add-complex-modal').classList.add('hidden');
    });

    document.getElementById('edit-node-name').addEventListener('input', (e) => {
        if (selectedNode) {
            selectedNode.label = e.target.value;
            updateGraph();
        }
    });

    const btnAddEdge = document.getElementById('btn-add-edge');
    if (btnAddEdge) {
        btnAddEdge.addEventListener('click', () => {
            isLinkingMode = !isLinkingMode;
            linkingSourceNode = null;
            btnAddEdge.classList.toggle('active', isLinkingMode);
            btnAddEdge.textContent = isLinkingMode ? 'Cancel Edge' : 'Add Edge';
            svg.classed('linking-mode', isLinkingMode);
            updateGraph();
        });
    }

    document.getElementById('btn-clear').addEventListener('click', () => {
        clearNetworkApp();
        const storyPanel = document.getElementById('story-panel');
        if (storyPanel) storyPanel.classList.add('hidden');
    });

    document.getElementById('btn-close-panel').addEventListener('click', () => {
        document.getElementById('properties-panel').classList.add('hidden');
        selectedNode = null;
        updateGraph();
    });

    const btnCloseStory = document.getElementById('btn-close-story');
    if (btnCloseStory) {
        btnCloseStory.addEventListener('click', () => {
            document.getElementById('story-panel').classList.add('hidden');
        });
    }

    // Modal event listeners
    document.getElementById('btn-open-advanced-matrix').addEventListener('click', () => {
        if (!selectedNode) return;
        renderAdvancedMatrixModal(selectedNode);
    });

    document.getElementById('btn-close-modal').addEventListener('click', () => {
        document.getElementById('advanced-matrix-modal').classList.add('hidden');
    });

    document.getElementById('btn-cancel-modal').addEventListener('click', () => {
        document.getElementById('advanced-matrix-modal').classList.add('hidden');
    });

    document.getElementById('btn-save-modal').addEventListener('click', () => {
        if (!selectedNode) return;
        saveAdvancedMatrixModal(selectedNode);
    });
}

function renderAdvancedMatrixModal(node) {
    const parentLinks = links.filter(l => l.target.id === node.id);
    const grid = document.getElementById('modal-cpt-grid');
    grid.innerHTML = '';

    document.getElementById('modal-node-name').textContent = `${node.label} - Advanced Matrix`;
    document.getElementById('modal-error-msg').classList.add('hidden');

    // We render the existing fullCustomCPT or fallback to the independent ones (customCPT)
    const renderCPT = node.fullCustomCPT ? node.fullCustomCPT : node.customCPT;

    // Create header row
    const headerRow = document.createElement('div');
    headerRow.className = 'cpt-header-row';
    const parentHeader = document.createElement('div');
    parentHeader.style.fontWeight = 'bold';
    parentHeader.textContent = parentLinks.length > 0 ? parentLinks.map(l => l.source.label).join(', ') : 'Prior';
    headerRow.appendChild(parentHeader);

    node.states.forEach(stateName => {
        const stateHeader = document.createElement('div');
        stateHeader.style.fontWeight = 'bold';
        stateHeader.textContent = `P(${stateName})`;
        headerRow.appendChild(stateHeader);
    });
    grid.appendChild(headerRow);

    const parentCombinations = getParentStateCombinations(parentLinks);
    const childNumStates = node.states.length;

    parentCombinations.forEach((combo, comboIndex) => {
        const row = document.createElement('div');
        row.className = 'cpt-row modal-input-row';
        row.style.flexWrap = 'nowrap'; // Ensure matrix stays as a grid internally
        row.style.overflowX = 'auto';

        const conditionDiv = document.createElement('div');
        if (combo.length === 0) {
            conditionDiv.textContent = 'Base';
        } else {
            conditionDiv.textContent = combo.map(ps => `${ps.parent.label}=${ps.stateName}`).join(', ');
        }
        conditionDiv.style.minWidth = "120px";
        row.appendChild(conditionDiv);

        for (let i = 0; i < childNumStates; i++) {
            const input = document.createElement('input');
            input.type = 'number';
            input.step = '0.01';
            input.min = '0';
            input.max = '1';
            const cptIndex = comboIndex * childNumStates + i;
            input.value = (renderCPT[cptIndex] || 0).toFixed(2);
            input.dataset.comboIndex = comboIndex;
            input.dataset.stateIndex = i;
            row.appendChild(input);
        }
        grid.appendChild(row);
    });

    document.getElementById('advanced-matrix-modal').classList.remove('hidden');
}

function saveAdvancedMatrixModal(node) {
    const childNumStates = node.states.length;
    const grid = document.getElementById('modal-cpt-grid');
    const rows = grid.querySelectorAll('.modal-input-row');

    let allValid = true;
    const newCPT = [];

    rows.forEach(row => {
        const inputs = Array.from(row.querySelectorAll('input'));
        let sum = 0;
        const tempVals = [];
        inputs.forEach(input => {
            let val = parseFloat(input.value);
            if (isNaN(val)) val = 0;
            sum += val;
            tempVals.push(val);
        });

        // Check fuzzy math validation (sum around 1.0)
        if (Math.abs(sum - 1.0) > 0.001) {
            row.classList.add('row-error');
            allValid = false;
        } else {
            row.classList.remove('row-error');
            tempVals.forEach(v => newCPT.push(v));
        }
    });

    if (!allValid) {
        document.getElementById('modal-error-msg').classList.remove('hidden');
        return;
    }

    document.getElementById('modal-error-msg').classList.add('hidden');
    node.fullCustomCPT = newCPT;
    setCptApp(node.id, newCPT);
    recalculateAll();
    updateGraph();
    updatePropertiesPanel(node);

    document.getElementById('advanced-matrix-modal').classList.add('hidden');
}

// ============================================
// V5 Features: Save / Load Configuration
// ============================================

document.getElementById('btn-save').addEventListener('click', () => {
    // We filter out D3's circular references implicitly by carefully building the payload
    const payload = {
        nodes: nodes.map(n => ({
            id: n.id,
            label: n.label,
            x: n.x,
            y: n.y,
            type: n.type,
            states: n.states,
            edgeCPTs: n.edgeCPTs,
            fullCustomCPT: n.fullCustomCPT,
            evidence: n.evidence
        })),
        links: links.map(l => ({
            source: l.source.id || l.source,
            target: l.target.id || l.target,
            type: l.type
        }))
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", "network_config.json");
    dlAnchorElem.click();
});

document.getElementById('btn-load').addEventListener('click', () => {
    document.getElementById('file-load').click(); // trigger hidden input
});

document.getElementById('file-load').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const config = JSON.parse(e.target.result);
            loadConfiguration(config);
        } catch (err) {
            alert("Error parsing network config file: " + err);
        }
    };
    reader.readAsText(file);
    event.target.value = ""; // reset for subsequent loads
});

function loadConfiguration(config) {
    // 1. Teardown
    clearNetworkApp();

    // Manage Story Panel visibility
    const storyPanel = document.getElementById('story-panel');
    if (storyPanel && config.story) {
        document.getElementById('story-title').innerText = config.story.title;
        document.getElementById('story-content').innerHTML = config.story.html;
        storyPanel.classList.remove('hidden');
    } else if (storyPanel) {
        storyPanel.classList.add('hidden');
    }

    // We must manually delete all old WASM nodes if we are brute-forcing the memory
    // (Ideally there would be a `clear_network` in WASM, but reloading solves it natively)

    // 2. Rebuild Nodes
    config.nodes.forEach(nData => {
        // Explicitly preserve the loaded ID string to ensure Edge matching works
        const newNode = {
            id: nData.id,
            label: nData.label,
            x: nData.x,
            y: nData.y,
            type: nData.type || 'basic',
            states: nData.states,
            evidence: nData.evidence !== undefined ? nData.evidence : null,
            edgeCPTs: nData.edgeCPTs || {},
            fullCustomCPT: nData.fullCustomCPT || null,
            marginalP: []
        };
        nodes.push(newNode);
        BEngine.ccall('create_node', 'void', ['string', 'number'], [newNode.id, newNode.states.length]);

        // Update the global counter to avoid future collisions by finding the highest 'n' integer appended.
        const numMatch = nData.id.match(/\d+/);
        if (numMatch) {
            let nNum = parseInt(numMatch[0]);
            if (nNum >= nodeCounter) nodeCounter = nNum + 1;
        }
    });

    // 3. Rebuild Edges
    config.links.forEach(lData => {
        const srcNode = nodes.find(n => n.id === lData.source);
        const tgtNode = nodes.find(n => n.id === lData.target);
        if (srcNode && tgtNode) {
            links.push({ source: srcNode, target: tgtNode, type: lData.type || 'neutral' });
            BEngine.ccall('add_edge', 'void', ['string', 'string'], [srcNode.id, tgtNode.id]);
        }
    });

    updateGraph();

    // 4. Force CPT Recalculation inside Engine
    // (Since we only saved the JS data, the WASM memory is blank until we re-trigger autoGenerateJointCPT)
    nodes.forEach(n => {
        if (n.fullCustomCPT) {
            setCptApp(n.id, n.fullCustomCPT);
        } else {
            autoGenerateJointCPT(n);
        }
    });

    // 5. Restore Evidence
    nodes.forEach(n => {
        if (n.evidence !== null) {
            setEvidenceApp(n.id, n.evidence);
        }
    });

    recalculateAll();
}

// ============================================
// V5 Features: Export SVG Canvas
// ============================================

document.getElementById('btn-export-svg').addEventListener('click', () => {
    const svgEl = document.getElementById('network-canvas');
    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svgEl);

    // Provide a namespace so it renders standalone
    if (!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)) {
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const dataStr = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", "network_canvas.svg");
    dlAnchorElem.click();
});

// ============================================
// V7 Features: Demo Loaders
// ============================================

document.getElementById('demo-loader').addEventListener('change', async (event) => {
    const filename = event.target.value;
    if (!filename) return;

    try {
        const response = await fetch(filename);
        if (!response.ok) throw new Error("Failed to fetch demo file.");
        const config = await response.json();

        loadConfiguration(config);

        // Reset dropdown so they can pick it again if needed
        event.target.value = "";
    } catch (err) {
        alert("Error loading demo scenario: " + err.message);
    }
});

// Start
window.onload = init;
