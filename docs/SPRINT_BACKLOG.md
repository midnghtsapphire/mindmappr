# Sprint Backlog: MindMappr Command Center

This document outlines the user stories, features, and acceptance criteria for the MindMappr Command Center project, organized by sprint.

## Sprint 1: Core Agent System, Chat, and Task Execution
**Goal:** Establish the foundational architecture for AI agents to receive instructions and execute basic tasks.

*   **User Story:** As a user, I want to chat with an AI agent so that I can give it commands.
    *   **Acceptance Criteria:**
        *   Chat interface exists with a text input and message history.
        *   System routes messages to the default LLM (Claude).
        *   Agent responses are displayed in the chat UI.
*   **User Story:** As a user, I want the agent to execute basic file operations (upload, download, delete) so that I can manage my workspace.
    *   **Acceptance Criteria:**
        *   File upload endpoint handles multipart form data.
        *   File download and delete endpoints are functional.
        *   Agent can trigger file operations via tool calls.
*   **User Story:** As a user, I want to see a history of tasks the agent has performed so that I can track its activity.
    *   **Acceptance Criteria:**
        *   Task history tab displays a list of executed tasks.
        *   Each task shows status (running, completed, failed) and execution time.

## Sprint 2: Auth, Deploy Tab, Agent Cards, File Management
**Goal:** Secure the application, improve the UI, and add deployment capabilities.

*   **User Story:** As a user, I want the application to be password protected so that unauthorized users cannot access my agents.
    *   **Acceptance Criteria:**
        *   Glassmorphism login page is implemented.
        *   Session cookies with a 24-hour TTL are used for authentication.
        *   API routes (except login and health) require a valid session.
*   **User Story:** As a user, I want to see visual cards for each available agent so that I can easily select who to chat with.
    *   **Acceptance Criteria:**
        *   Agents tab displays cards for all built-in agents (Rex, Watcher, Scheduler, Processor, Generator).
        *   Clicking an agent card opens a chat session with that specific agent.
*   **User Story:** As a user, I want a dedicated Deploy tab so that I can manage GitHub PRs and deployments without leaving the app.
    *   **Acceptance Criteria:**
        *   Deploy tab lists open GitHub PRs for configured repositories.
        *   UI provides a button to merge PRs directly.
*   **User Story:** As a user, I want a dedicated Files tab so that I can view and manage all files in the system.
    *   **Acceptance Criteria:**
        *   Files tab lists all uploaded and generated files.
        *   UI supports inline previews for images, audio, and video.

## Sprint 3: Custom Agents, Dynamic Agent Creation, Connections, APIs
**Goal:** Allow users to customize their agent workforce and connect external services.

*   **User Story:** As a user, I want to create custom agents with specific roles and system prompts so that I can tailor the AI to my needs.
    *   **Acceptance Criteria:**
        *   UI provides a form to define a new agent (name, model, role, prompt, icon, color).
        *   Custom agents are saved to the database and appear in the Agents tab.
        *   Custom agents can be invoked in chat just like built-in agents.
*   **User Story:** As a user, I want to connect external services (GitHub, DigitalOcean, Slack, etc.) so that my agents can interact with them.
    *   **Acceptance Criteria:**
        *   Connections tab allows users to input API tokens for supported services.
        *   Tokens are securely stored and retrieved when needed by tools.
*   **User Story:** As a user, I want to register custom API endpoints so that my agents can call my own services.
    *   **Acceptance Criteria:**
        *   APIs tab allows users to define custom API endpoints and keys.
        *   Agents can use the `web_scrape` or custom tools to interact with these APIs.

## Sprint 4: Activity Window, Rex Tools, SQLite Persistence
**Goal:** Enhance visibility into agent actions, expand Rex's capabilities, and ensure data durability.

*   **User Story:** As a user, I want to see a live "Activity Window" so that I know what every agent is currently doing.
    *   **Acceptance Criteria:**
        *   Activity tab displays a "virtual office" view with real-time status for all agents.
        *   Background simulation generates ambient activity for idle agents.
        *   Agent actions (tool use, chat) update their status in the Activity Window.
*   **User Story:** As a user, I want Rex to have a comprehensive suite of tools (GitHub, DigitalOcean, LLM) so that he can manage my infrastructure.
    *   **Acceptance Criteria:**
        *   `rex-tools.mjs` implements 21 specific tool functions (e.g., `github_create_repo`, `do_list_droplets`).
        *   Rex's system prompt includes instructions on how to use these tools.
        *   Tool executions are logged in the Activity Window.
*   **User Story:** As a user, I want all configuration and memory to be stored in SQLite so that it persists across ephemeral container deployments.
    *   **Acceptance Criteria:**
        *   Connections, API keys, custom agents, and agent memory are migrated to SQLite (`mindmappr.db`).
        *   Data survives application restarts.

## Sprint 5: Content Studio, 260 Rex Skills
**Goal:** Introduce advanced content creation capabilities and expand the skill library.

*   **User Story:** As a user, I want a "Content Studio" so that I can generate, score, and repurpose marketing content.
    *   **Acceptance Criteria:**
        *   Content Studio tab includes tools for Composing, Scoring, Braindumping, Repurposing, Coaching, and Researching.
        *   Content is saved to SQLite tables (`content_studio_posts`, etc.).
        *   Generator agent is integrated to power the Content Studio tools.
*   **User Story:** As a user, I want Rex to have access to a massive library of skills so that he can perform complex workflows autonomously.
    *   **Acceptance Criteria:**
        *   Rex's system prompt is updated to reference the external skill library.
        *   `/api/agents/rex/skills` endpoint serves the skills registry.
