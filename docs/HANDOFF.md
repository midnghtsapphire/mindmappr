# HANDOFF: MindMappr Command Center

This document provides a comprehensive guide for anyone taking over the MindMappr Command Center project.

## Architecture Overview

MindMappr is a self-contained Node.js application designed as a single-file server (`server.mjs`) for ease of deployment. It orchestrates multiple AI agents, manages connections to external services, and provides a modern web interface.

The core logic resides in `server.mjs`. This file handles Express routing, API endpoints, agent orchestration (routing messages to specific LLMs via OpenRouter), database interactions (SQLite), and file management.

The `rex-tools.mjs` module contains 21 executable functions specifically designed for the Rex agent. These tools enable autonomous interactions with GitHub (creating repos, managing PRs), DigitalOcean (managing droplets and apps), and other services.

The frontend is a Single Page Application (SPA) located entirely within `public/index.html`. It uses a glassmorphism UI and communicates with the backend via REST APIs. There is no build step required for the frontend.

Data persistence is handled by a SQLite database (`data/mindmappr.db`), ensuring that user preferences, connections, API keys, and agent memory survive container restarts on ephemeral hosting platforms.

## How to Run Locally

To run MindMappr locally for development or testing:

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/midnghtsapphire/mindmappr.git
    cd mindmappr
    ```
2.  **Install dependencies:** Ensure you have Node.js 20+ installed. The `better-sqlite3` package requires native build tools (e.g., `make`, `g++`, `python3`).
    ```bash
    npm install
    ```
3.  **Set environment variables:** Create a `.env` file in the root directory (see "Environment Variables Needed" below).
4.  **Start the server:**
    ```bash
    npm start
    ```
5.  **Access the application:** Open your browser and navigate to `http://localhost:3005`.

## How to Deploy

MindMappr is optimized for deployment on DigitalOcean App Platform.

1.  **Connect your GitHub repository** to DigitalOcean App Platform.
2.  **Select the MindMappr repository** and the `master` branch.
3.  **Configure the App:** DO App Platform should automatically detect the `Dockerfile`. Ensure the run command is `node server.mjs`.
4.  **Set Environment Variables:** Add the required environment variables (e.g., `APP_PASSWORD`, `LLM_API_KEY`) in the App Platform configuration.
5.  **Deploy:** Trigger the deployment. The SQLite database will persist across redeployments on the App Platform.

## Environment Variables Needed

The following environment variables are required or highly recommended:

*   `PORT`: The port the server will listen on (default is 3005).
*   `APP_PASSWORD`: The password required to access the MindMappr UI.
*   `LLM_API_KEY`: Your OpenRouter API key (or OpenAI key if overriding the base URL). This is required for all agent LLM calls.
*   `LLM_MODEL`: The default LLM model to use (default is `anthropic/claude-sonnet-4`).
*   `GITHUB_PAT`: A GitHub Personal Access Token with repo scopes, required for Rex's GitHub tools (can also be set in the UI Connections tab).
*   `DO_API_TOKEN`: A DigitalOcean API token, required for Rex's DO tools (can also be set in the UI Connections tab).

## Database Schema

The SQLite database (`mindmappr.db`) contains the following key tables:

*   `user_preferences`: Key-value store for UI settings.
*   `facts`: Long-term memory for agents, storing categorized facts.
*   `conversation_summaries`: Summaries of past chat sessions.
*   `project_context`: Details about ongoing projects.
*   `scheduled_tasks`: Configuration for cron jobs.
*   `agent_tasks`: History of all tasks executed by agents, including status and cost.
*   `custom_agents`: Definitions for user-created agents.
*   `agent_activity`: Real-time logs of agent actions for the Activity Window.
*   `connections`: Secure storage for external service tokens (e.g., GitHub, Slack).
*   `content_studio_posts`: Storage for content generated in the Content Studio.
*   `content_studio_inspirations`: Storage for repurposed content sources.
*   `content_studio_braindumps`: Storage for raw thoughts and generated drafts.
*   `content_studio_analytics`: Performance metrics for published content.

## API Endpoint Reference

Key API endpoints include:

*   `POST /api/auth/login`: Authenticate with `APP_PASSWORD`.
*   `GET /api/health`: Check server status and available features.
*   `POST /api/chat`: Send a message to the default agent.
*   `POST /api/agents/:name/invoke`: Invoke a specific built-in or custom agent.
*   `GET /api/agents`: List all available agents and their current status.
*   `GET /api/activity/live`: Get real-time status for the Activity Window.
*   `GET /api/tools`: List all available Rex tools.
*   `POST /api/tools/execute`: Manually execute a Rex tool.
*   `GET /api/connections/list`: List configured external connections.
*   `POST /api/schedule`: Create a new scheduled task.
*   `POST /api/content-studio/compose`: Generate content using the CreatorBuddy suite.

## Agent System Overview

MindMappr employs a specialized workforce of AI agents, each with a defined role and system prompt:

*   **Rex:** The lead infrastructure agent. He uses `rex-tools.mjs` to manage GitHub repos, deploy to DigitalOcean, and execute complex workflows.
*   **Watcher:** The monitoring agent. Focuses on system health, API response times, and log analysis.
*   **Scheduler:** The automation agent. Manages cron jobs and recurring tasks.
*   **Processor:** The data agent. Handles fast data operations, parsing, and extraction.
*   **Generator:** The content agent. Powers the Content Studio, creating blog posts, marketing copy, and reports.

Users can also create **Custom Agents** with specific models and instructions via the UI.

## Known Issues and Tech Debt

*   **Single-File Architecture:** `server.mjs` is very large. Consider refactoring into separate modules (e.g., routing, database, agent logic) if the project grows significantly.
*   **Branch Protection:** The repository currently lacks branch protection rules, which led to the April 3 force-push incident. This must be implemented immediately to enforce PR workflows.
*   **Test Coverage:** There is currently no automated test suite. Adding unit tests for `rex-tools.mjs` and API endpoints is highly recommended.
*   **Rate Limiting:** While the Generator agent has a basic rate limit, more robust rate limiting across all API endpoints should be implemented for production deployments.
