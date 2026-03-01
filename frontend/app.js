// app.js

// --- Global Application State ---
let BEngine = null; // The WebAssembly module instance
let nodes = [];
let links = [];
let selectedNode = null;
let nodeCounter = 0;

// --- D3 Canvas Setup ---
const svg = d3.select("#network-canvas");
const width = svg.node().clientWidth;
const height = svg.node().clientHeight;

const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(150))
    .force("charge", d3.forceManyBody().strength(-400))
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
    const idA = addNodeToApp("Weather", width / 2, height / 2 - 100);
    const idB = addNodeToApp("Murder", width / 2, height / 2 + 100);

    // 2. Link them
    addLink(idA, idB);

    // 3. Set CPTs in WASM 
    // Weather (True=Bad, False=Good) -> 20% Bad
    setCptWasm(idA, [0.2, 0.8]);

    // Murder | Weather. Order: [M=T | W=T], [M=F | W=T], [M=T | W=F], [M=F | W=F]
    // If Weather is Bad (True), Murder=True is 50%. If Good (False), Murder=True is 5%
    setCptWasm(idB, [0.5, 0.5, 0.05, 0.95]);

    recalculateAll();
}

// --- WASM Interface Wrappers ---

function addNodeToWasm(id) {
    if (!BEngine) return;
    // We assume all variables are binary (True/False) for this UI
    BEngine.ccall('create_node', 'void', ['string', 'number'], [id, 2]);
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

    // Create a new Float32Array view directly over the module's WASM memory
    const memory = BEngine.wasmMemory || BEngine.memory;
    const buffer = memory ? memory.buffer : BEngine.HEAP8.buffer;
    const view = new Float32Array(buffer, ptr, probArray.length);
    view.set(probArray);

    BEngine.ccall('set_cpt', 'void', ['string', 'number', 'number'], [nodeId, ptr, probArray.length]);
    _free(ptr);
}

function setEvidenceWasm(nodeId, stateIndex) {
    if (!BEngine) return;
    BEngine.ccall('set_evidence', 'void', ['string', 'number'], [nodeId, stateIndex]);
}

function getMarginalsWasm(nodeId) {
    if (!BEngine) return [0, 0];
    const _malloc = BEngine._malloc || BEngine.malloc || (size => BEngine.ccall('malloc', 'number', ['number'], [size]));
    const _free = BEngine._free || BEngine.free || (ptr => BEngine.ccall('free', 'void', ['number'], [ptr]));

    const ptr = _malloc(2 * 4); // 2 floats
    BEngine.ccall('get_marginals', 'void', ['string', 'number', 'number'], [nodeId, ptr, 2]);

    const memory = BEngine.wasmMemory || BEngine.memory;
    const buffer = memory ? memory.buffer : BEngine.HEAP8.buffer;
    const view = new Float32Array(buffer, ptr, 2);
    const output = [view[0], view[1]];

    _free(ptr);
    return output;
}

// --- Core App Logic ---

function addNodeToApp(name, x, y) {
    const id = "N" + (++nodeCounter);
    const label = name || id;

    const newNode = { id, label, x, y, evidence: -1 };
    nodes.push(newNode);

    addNodeToWasm(id);

    updateGraph();
    return id;
}

function addLink(sourceId, targetId) {
    const sourceNode = nodes.find(n => n.id === sourceId);
    const targetNode = nodes.find(n => n.id === targetId);

    if (sourceNode && targetNode && sourceId !== targetId) {
        // Prevent dupes
        if (!links.some(l => l.source.id === sourceId && l.target.id === targetId)) {
            links.push({ source: sourceNode, target: targetNode });
            addEdgeToWasm(sourceId, targetId);
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
        .attr("class", "link")
        .attr("marker-end", "url(#arrow)");
    linkElements = linkEnter.merge(linkElements);

    // Nodes
    nodeElements = nodeElements.data(nodes, d => d.id);
    nodeElements.exit().remove();

    const nodeEnter = nodeElements.enter().append("g")
        .attr("class", "node")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended))
        .on("click", (event, d) => selectNode(d));

    nodeEnter.append("circle").attr("r", 30);
    nodeEnter.append("text")
        .attr("dy", ".35em")
        .attr("text-anchor", "middle")
        .text(d => d.label);

    nodeElements = nodeEnter.merge(nodeElements);

    // Rebind CSS classes based on state
    nodeElements.attr("class", d => {
        let cls = "node";
        if (selectedNode && d.id === selectedNode.id) cls += " selected";
        if (d.evidence === 0) cls += " evidence-true";
        if (d.evidence === 1) cls += " evidence-false";
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
    linkElements.attr("d", d => {
        const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
        const dr = Math.sqrt(dx * dx + dy * dy) * 1.5; // Curved edges
        return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
    });
    nodeElements.attr("transform", d => `translate(${d.x},${d.y})`);
});

// --- UI Interactions ---

function selectNode(d) {
    selectedNode = d;
    updateGraph(); // trigger highlighting

    document.getElementById('panel-empty').classList.add('hidden');
    document.getElementById('panel-editor').classList.remove('hidden');
    document.getElementById('properties-panel').classList.remove('hidden');

    updatePropertiesPanel(d);
}

function updatePropertiesPanel(d) {
    document.getElementById('edit-node-name').textContent = d.label;

    // Evidence buttons
    document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
    let stateStr = "none";
    if (d.evidence === 0) stateStr = "0";
    if (d.evidence === 1) stateStr = "1";
    document.querySelector(`.toggle-btn[data-state="${stateStr}"]`).classList.add('active');

    // Probabilities
    if (d.marginals) {
        const pTrue = (d.marginals[0] * 100).toFixed(1);
        const pFalse = (d.marginals[1] * 100).toFixed(1);

        document.getElementById('prob-true-pct').textContent = pTrue + '%';
        document.getElementById('prob-false-pct').textContent = pFalse + '%';

        document.getElementById('prob-true-bar').style.width = pTrue + '%';
        document.getElementById('prob-false-bar').style.width = pFalse + '%';
    }
}

function setupEventListeners() {
    document.getElementById('btn-add-node').addEventListener('click', () => {
        addNodeToApp("New Var", width / 2, height / 2);
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
        nodes = [];
        links = [];
        nodeCounter = 0;
        selectedNode = null;
        if (BEngine) BEngine.ccall('clear_all_evidence', 'void', [], []);
        updateGraph();
        document.getElementById('properties-panel').classList.add('hidden');
    });

    document.getElementById('btn-close-panel').addEventListener('click', () => {
        document.getElementById('properties-panel').classList.add('hidden');
        selectedNode = null;
        updateGraph();
    });

    // Evidence toggles
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (!selectedNode) return;
            const state = e.target.getAttribute('data-state');

            if (state === "none") {
                selectedNode.evidence = -1;
            } else {
                selectedNode.evidence = parseInt(state);
            }

            setEvidenceWasm(selectedNode.id, selectedNode.evidence);
            recalculateAll();
            updateGraph(); // UI update
        });
    });
}

// Start
window.onload = init;
