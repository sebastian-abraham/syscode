# Product Brief: An Agentic Dev Tool Built Around a Living Design Map

> **How to use this document:** This describes *what the product is and how it should feel to use*. It is deliberately not a technical spec. Where implementation details appear, they are suggestions, not requirements. If you are unsure about a decision, favor the intent described here over any specific technique.

---

## 1. The One-Paragraph Version

This is a developer tool where an AI agent builds and modifies software, and a **visual, zoomable map of the system** keeps the developer in control and in understanding of what is being built. The map is not a diagram generated from the file system. It is a **communication space**: the AI's way of explaining to the developer "here is what this system is, how its parts relate, and why it is shaped this way", at whatever level of detail the developer cares about right now. The developer can steer the AI *through* the map, through chat, or by editing code directly, and all three stay in sync.

---

## 2. The Problem We're Solving

Language models are now very good at writing syntax. With the right docs or tooling, "how do I write this in framework X" is largely solved.

What AI still does poorly, and what developers increasingly lose, is:

1. **Architecture and design decisions.** Where should this live? What should depend on what? Should this be a new module or an extension of an existing one?
2. **Understanding.** When an agent writes thousands of lines, the developer ends up with software they do not understand. They lose their mental model of the system, and with it, control.

Today's agent tools output code and diffs. Diffs show *what changed*, not *what the system is*. This product's job is to give the developer back the mental model.

---

## 3. What This Is NOT (Read This Carefully)

An earlier attempt at building this produced the wrong thing. Please avoid these:

- **NOT a file-to-node converter.** Nodes are not "one per file" or "one per function". A file tree drawn as boxes is not the product.
- **NOT a call graph, dependency graph, or UML diagram generator.** Those may be *sources of facts* that feed the system, but they are not the output.
- **NOT a rigid schema.** There is no fixed set of node types like "Controller", "Service", "Model" that every project must fit into. The system must work for any language or stack without us hand-modeling each one.
- **NOT a read-only documentation viewer.** The map is interactive and is a way of *giving instructions*, not just reading.
- **NOT regenerated from scratch on each run.** The map must be stable and persistent (see section 7).

If what you are building looks like "parse the repo, make a box per file, draw arrows for imports", that is the wrong direction.

---

## 4. Core Concept: The Map as a Conversation

Think of the map the way you would think of a whiteboard sketch a senior engineer draws while explaining a system to a new teammate. They don't draw every file. They draw:

- "This is the part that handles user accounts."
- "It talks to this payment piece, which is basically a wrapper around Stripe."
- "This background worker is where the slow stuff happens."

Then, if you ask "how does the payment piece work?", they zoom in and draw a new diagram of just that part.

That is the product. The AI is the senior engineer at the whiteboard. The developer can stop it at any level.

### What a node is

A node is **a meaningful unit of the system as the AI would explain it to a human**. It might correspond to:

- a feature ("checkout flow")
- a subsystem ("authentication")
- a piece of data ("user profile")
- a single important function or file
- an external service ("Stripe", "Postgres")
- a concern that cuts across code ("error handling strategy")

A node can map to one file, many files, part of a file, or no code at all yet (a planned component). The AI decides what grouping makes sense. Nodes carry a **plain-language explanation**, not just a name.

### What an edge is

An edge is a **relationship worth communicating**: "sends data to", "depends on", "is triggered by", "stores in". Edges can have short labels. They are not necessarily one-to-one with imports or function calls.

---

## 5. Layers of Abstraction (Semantic Zoom)

The map has multiple **levels of detail**, and the developer chooses how deep to look.

| Level | What the developer sees | Example |
|---|---|---|
| **Top** | The system in a handful of big pieces | "Web app, API, database, background jobs, payment provider" |
| **Mid** | What's inside each piece, in terms of features and responsibilities | Inside API: "auth, orders, notifications, admin" |
| **Detailed** | Specific components and how they interact | Inside orders: "create order, validate cart, reserve stock, charge payment" |
| **Code** | The actual code, linked to the node | The relevant files and functions |

Key behaviors:

- **Zooming is about meaning, not just visual scale.** Expanding a node reveals what's *inside* it conceptually, not just a bigger rendering.
- **A developer can stay at the top level forever** if that's what they care about. They never have to see code to direct the agent.
- **The number of visible nodes at any level must stay small** (roughly a handful to a dozen). A cluttered map is a failed map. If a level has too much, the AI should group and introduce another layer.
- **Different questions may deserve different views.** For example, "how does data move?" might be shown differently than "what depends on what?". The AI can choose the framing that answers the user's question, rather than forcing one graph shape.

---

## 6. Two-Way Interaction (This Is the Main Point)

The map is not just something to look at. It is one of three equal ways to work on the project, and they stay synchronized.

### 6a. Working through the map

The developer can:

- **Add a node** and describe it: *"a node that takes a list of orders and outputs a sales summary"*. The agent figures out how to implement it and what it needs.
- **Connect nodes** to say how they relate. The agent works out what that connection means in code.
- **Move, merge, split, rename, or delete nodes** to express design intent.
- **Pin notes and constraints** to nodes: *"never call the database directly from here"*, *"this must stay under 100ms"*, *"we chose X over Y because..."*.

### 6b. Working through chat

A chat panel sits alongside the map. The developer can say things like:

- *"Add a feature that lets users export their data."* The agent decides what nodes and connections are needed, shows the plan on the map, and implements it after approval.
- *"Why does the payment piece depend on the user piece?"*
- *"Create a node that does X, I'll connect it myself."*
- *"Attach yourself to this node and refactor it."* The chat can be scoped to a node, so the agent works with focused context for that area.

### 6c. Working through code directly

Developers will still edit code by hand in their own editor. When they do, they can press **Update** and the system reads the changes (via the diff or the new code) and **updates the map accordingly**. The map should reflect reality, not a stale plan.

### Review before implementation

For meaningful changes, the agent should **propose the design change on the map first**: "I'd add this new node here, connected to these two things, and change this relationship." The developer can approve, edit, or reject *before* code is written. This is where control comes back: architecture review happens before implementation, not after.

---

## 7. Stability: The Map Must Not Reshuffle

This is the hardest and most important design constraint.

If the map looks different every time the agent runs, it stops being a map and becomes noise. The developer builds a mental picture over time, and that picture must persist.

Principles:

- **Updates are changes to an existing map, not regeneration.** When code changes, the system works out what *changed* in the map (add this, rename that, move this, remove that) rather than redrawing everything.
- **Nodes have persistent identity.** A node that was "checkout flow" yesterday is still the same node today, even if its files moved or its code was rewritten.
- **User decisions are protected.** Positions, groupings, names, notes, and pinned constraints that the developer set are not overwritten by the AI without approval.
- **Some rules, some flexibility.** The rules cover *identity and persistence*: what makes a node the same node, what's protected, how changes are applied. The AI keeps freedom over *naming, grouping, and explanation*. We deliberately avoid a rigid structure on content while keeping a firm structure on stability.
- **Stale detection.** If code under a node changes in a way the map doesn't yet reflect, the node should be visibly marked as possibly out of date, rather than silently lying.

---

## 8. Grounding: The Map Must Be Honest

A confident but wrong diagram is worse than no diagram. The AI generates the map, but the map must be tied to reality:

- Every node links back to real code (files, symbols, line ranges) where code exists.
- Facts about the code (what files exist, what imports what, what functions are defined) come from **deterministic analysis** such as syntax-tree parsing and language tooling.
- That factual data is **fed to the AI as input**. The map is *not* mechanically produced from it. The facts keep the AI honest; the AI provides the meaning, grouping, and explanation.
- Where the AI is inferring rather than verifying (e.g. "this is probably the auth layer"), that is fine, but verified links should be distinguishable from inferred ones if possible.

---

## 9. Memory and Context Management

A major goal is that the agent gets **specific, concise, relevant information** for the task at hand, not a dump of files and file names.

### Project memory

When a project is first opened (especially an existing codebase), the system runs a **mapping process** where the AI takes its time to understand the project:

- what stack and frameworks are used
- where things live
- project conventions and patterns
- what each major area does

This builds up persistent memory so the agent doesn't have to re-explore the repo every time. A second pass then builds the initial map from that understanding.

### The map as context

The map and memory work together:

- Notes, decisions, constraints, and gotchas are **attached to nodes**.
- When the agent works on a node, it pulls **scoped context for that node**: its explanation, linked code, related nodes, pinned constraints, and relevant decisions. It does not need the whole repo.
- Design decisions get captured naturally as a byproduct of using the tool ("we chose this approach because...").
- Questions like "how does login work?" should be answerable **from the map and memory** without re-scanning the codebase.

### Transparency

The developer should be able to see what context the agent was given for a task. No hidden surprises about what the AI "knew".

---

## 10. Works for New and Existing Projects

If the core is done well, there shouldn't be a big difference:

- **Existing codebase:** run the mapping process to build memory and an initial map, then work from there.
- **Starting from scratch:** the map starts empty or near-empty and grows as the developer and agent design the system together. Planned nodes can exist before any code does.

---

## 11. Typical User Journeys

**Journey A: Understanding an inherited codebase**
1. Developer opens an unfamiliar project.
2. The system maps it. They see a top-level view of 5 or 6 big pieces with plain-language explanations.
3. They click into the piece they must change, zoom in, and read how it works.
4. They ask in chat "what would break if I changed this?" and get an answer grounded in the map.

**Journey B: Building a new feature**
1. Developer types "add a referral system where users earn credits."
2. The agent proposes a design change on the map: a new "Referrals" node, connected to "Users" and "Billing", with a short rationale.
3. The developer drags the node, renames it, adds a note "credits expire after 90 days", and approves.
4. The agent implements it. The map updates and the new node links to the real code.

**Journey C: Designing first, implementing later**
1. Developer sketches nodes with descriptions and connects them: "email parser" → "classifier" → "dashboard".
2. They tell the agent "implement the classifier node."
3. The agent builds it with context scoped to that node and its neighbors.

**Journey D: Hand-editing**
1. Developer refactors by hand in their editor.
2. They press Update. The system detects what changed and adjusts the map (a node renamed, a connection removed) without redrawing everything.

---

## 12. What Success Looks Like

The strongest test: **can someone who did not write the code understand it, answer questions about it, or safely change it faster with this tool than without it?**

More concretely:

- After the agent builds something, the developer can explain how it works without reading all the code.
- The map is trusted because it is stable and grounded, not a pretty picture that drifts.
- Developers feel *in charge of the architecture*, with the agent doing the typing.

---

## 13. Technical Direction (Non-Binding)

These are current leanings and may change. They should not drive product decisions.

- Core agent and logic in **TypeScript**.
- Interface in a **React-based web frontend**, packaged as a desktop app with **Tauri**.
- **SQLite** for local storage of project index and memory.
- Code analysis via **syntax-tree-based parsing** (specific tooling still under evaluation).
- **Model-agnostic**: no hard dependency on a single LLM provider.
- Architecture should separate a **core engine** (analysis, memory, map, agent) from the **interface**, so other surfaces (such as an editor extension) could be added later.

---

## 14. Suggested Build Order

Prioritize risk, not polish:

1. **Core engine without UI:** project mapping, memory, and scoped context. Verify it can answer questions about a real repo accurately.
2. **The map model and update mechanism:** persistent nodes, stable identity, and applying *changes* to the map rather than regenerating. Test by changing code and checking the map updates sensibly.
3. **The visual canvas:** zoom levels, expand and collapse, click through to code, stale indicators.
4. **Two-way flow:** chat that creates and edits nodes, design-change approval before implementation, and the Update-after-manual-edit path.
5. **Evaluation:** compare comprehension and change-safety with and without the tool.

Start with **one language/stack** and do it well rather than supporting many shallowly.

---

## 15. Guidance for the Implementing Agent

- When in doubt, ask: *"Does this help the developer understand and steer the system at the level they care about?"*
- Prefer **a small number of meaningful nodes** over exhaustive coverage.
- Never produce a map that is just a restatement of the file tree.
- Keep the AI's freedom in **meaning and explanation**, and keep strictness in **identity, persistence, and honesty about what's verified**.
- If you're unsure what a feature should look like, describe your interpretation and check it against sections 3 and 4 before building.
