# DARE: Decide, Act, Review, Evolve

This document outlines the strategic decisions, implementation actions, reviews of past incidents, and the evolution roadmap for the MindMappr Command Center.

## Decide: Architectural Decisions

The architecture of MindMappr was driven by the need for a self-contained, easily deployable command center that could manage multiple AI agents, interact with external services, and persist data across ephemeral environments.

The primary architectural decision was to utilize a **single-file server** (`server.mjs`). This approach simplifies deployment and reduces the overhead of managing complex directory structures for a tool primarily intended for internal use. The server handles routing, API endpoints, agent orchestration, and database interactions.

For data persistence, **SQLite** was chosen over file-based JSON storage or a separate database service. The shift to SQLite (`better-sqlite3`) was a critical decision to ensure data durability on platforms like DigitalOcean App Platform, which utilize ephemeral containers. SQLite provides a robust, zero-configuration database that persists across container restarts, safeguarding user preferences, connections, API keys, and agent memory.

The **glassmorphism UI** was selected to provide a modern, sleek, and cinematic user experience. The frontend is built as a Single Page Application (SPA) within `public/index.html`, eliminating the need for a complex build step (like Vite or Webpack) and keeping the deployment footprint minimal.

For AI capabilities, **OpenRouter** was selected as the LLM gateway. This decision allows MindMappr to easily switch between different models (e.g., Claude 3.5 Sonnet, GPT-4o) without changing the core integration logic, providing flexibility and cost control.

## Act: Implementation Details

The implementation of MindMappr involved building a comprehensive suite of tools and interfaces to support the autonomous agents.

The core of the system is the **Agent Orchestration Engine** in `server.mjs`. It manages a roster of built-in agents (Rex, Watcher, Scheduler, Processor, Generator), each with a specific role, system prompt, and designated LLM model. The engine handles message routing, maintains session history, and executes tool calls parsed from the LLM responses.

A significant implementation effort was the **Rex Tools System** (`rex-tools.mjs`). This module provides 21 distinct, executable functions that allow the Rex agent to interact with GitHub (creating repos, listing PRs, pushing files), DigitalOcean (listing droplets, restarting apps), and other services. The tools are dynamically registered and their descriptions are injected into Rex's system prompt, enabling autonomous infrastructure management.

The **Connections and API Key Management** system was built to securely store credentials. The UI provides a dedicated tab for users to input tokens (e.g., GitHub PAT, DO API Token). These tokens are saved to the SQLite database and retrieved by the `rex-tools` module when executing commands, ensuring that agents have the necessary permissions to act on the user's behalf.

The **Content Studio** was integrated to provide a CreatorBuddy-style suite for marketing and content generation. It includes specialized tools for composing posts, scoring content based on platform algorithms, braindumping ideas, and repurposing existing material. This module leverages the Generator agent and stores all content in dedicated SQLite tables.

## Review: Incidents and Lessons Learned

The development of MindMappr has encountered challenges, primarily related to deployment workflows and data persistence.

The most significant incident was the **April 3 Force-Push Vulnerability**. Multiple teams (Credentials, Activity Window, Content Studio) were working concurrently and pushing directly to the `master` branch. The Content Studio team executed a force-push, which inadvertently overwrote the commits from the other teams, resulting in the loss of the `rex-tools.mjs` file, the Activity Window features, and the tool-use loop in the server.

This incident highlighted a critical flaw in the repository management strategy. The lesson learned is that direct pushes to `master`, especially force-pushes, must be strictly prohibited. A formal PR-based workflow, enforced by branch protection rules, is essential when multiple developers or automated agents are collaborating on a single repository.

Another major issue was the **Ephemeral Storage Bug**. Initially, connections and API keys were stored in local JSON files (`data/connections.json`). When deployed to DigitalOcean App Platform, these files were wiped during every deployment or container restart, forcing users to re-enter their credentials constantly.

The review of this bug led to the architectural decision to migrate all persistent data to SQLite. This experience reinforced the importance of understanding the target deployment environment's constraints (e.g., ephemeral filesystems) early in the design phase.

## Evolve: Improvement Roadmap

The future evolution of MindMappr focuses on enhancing agent autonomy, expanding integrations, and solidifying the deployment pipeline.

The immediate priority is to **Enforce Branch Protection and PR Workflows**. To prevent future force-push incidents, the repository must be configured to require pull requests, mandate code reviews (potentially utilizing automated tools like Coderabbit), and block direct pushes to the main branch.

The **Rex Tool Ecosystem** will be expanded to include more complex workflows. This involves integrating the 260 skills from the OpenAudrey project, allowing Rex to perform multi-step operations across various platforms without requiring explicit, step-by-step instructions from the user.

Finally, the **Analytics and Observability** capabilities will be enhanced. While the Activity Window provides real-time status, historical analytics regarding agent utilization, token costs, and task success rates need to be more granular. This will involve expanding the `agent_tasks` and `agent_activity` tables and building more comprehensive dashboards in the UI.
