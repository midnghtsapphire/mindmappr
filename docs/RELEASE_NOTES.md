# Release Notes: MindMappr Command Center

This document chronicles the version history and feature additions for the MindMappr Command Center.

## Version 8.0: Activity Window, Rex Tools, Content Studio
**Release Date:** April 3, 2026

Version 8.0 represents a massive expansion of the MindMappr platform, introducing comprehensive agent observability, autonomous infrastructure management, and a full-featured content creation suite. This release also addresses critical data persistence issues from previous versions.

*   **Activity Window:** A new "virtual office" view provides real-time visibility into the actions of all agents. Users can monitor what each agent is doing, view background simulations for idle agents, and track tool executions.
*   **Rex Tools (21 Real API Tools):** The Rex agent has been supercharged with 21 executable functions. Rex can now autonomously manage GitHub repositories (create, list, push files, merge PRs), interact with DigitalOcean (list droplets, restart apps), and utilize LLM APIs for code review and generation.
*   **Content Studio:** A CreatorBuddy-style suite has been integrated, providing advanced AI-powered tools for marketing and content generation. Features include composing posts tailored for specific platforms, scoring content against algorithms, braindumping ideas, repurposing existing material, and researching accounts.
*   **SQLite Persistence:** To resolve the ephemeral storage bug on DigitalOcean App Platform, all critical data—including connections, API keys, custom agents, and agent memory—has been migrated to a robust SQLite database (`mindmappr.db`).
*   **Expanded Skill Library:** Rex now has access to 260 skills from the OpenAudrey project, significantly broadening his autonomous capabilities.

## Version 7.0: Custom Agents, Deploy Tab, Connections, Analytics
**Release Date:** March 2026

Version 7.0 focused on user customization and extending the platform's reach to external services.

*   **Custom Agents:** Users can now create and define their own AI agents with specific roles, models, and system prompts directly from the UI.
*   **Deploy Tab:** A dedicated Deploy Center allows users to view and merge GitHub pull requests without leaving the MindMappr interface.
*   **Connections and APIs:** The Connections panel was introduced to securely store API tokens for services like GitHub, DigitalOcean, and Slack. The APIs tab allows users to register custom endpoints for their agents to call.
*   **Analytics:** A new Analytics tab provides usage statistics, token consumption, and task history for the agent workforce.

## Version 6.0: OpenAudrey Integration
**Release Date:** February 2026

Version 6.0 integrated the core OpenAudrey agents into the MindMappr Command Center, establishing the specialized workforce.

*   **Agent Roster:** The built-in agents—Rex (Infrastructure), Watcher (Monitoring), Scheduler (Automation), Processor (Data), and Generator (Content)—were officially integrated, each with distinct roles and system prompts.
*   **Agent Cards:** The UI was updated with visual cards for each agent, allowing users to click and chat with specific specialists.

## Version 5.0: Multi-Step Planner, SQLite Memory, Cron Scheduler
**Release Date:** January 2026

Version 5.0 laid the foundation for complex, autonomous agent workflows.

*   **Multi-Step Planner:** The execution engine was upgraded to handle multi-step task plans, allowing agents to perform sequential operations.
*   **Long-Term Memory:** SQLite was introduced to provide long-term memory for agents, enabling them to recall facts, user preferences, and project context across sessions.
*   **Cron Scheduler:** A built-in cron scheduler allows users to set up recurring tasks and assign them to specific agents for automated execution.
*   **Error Recovery:** The system was enhanced with retry mechanisms and exponential backoff to handle transient API failures gracefully.

## Versions 1.0 - 4.0: Early Iterations
**Release Dates:** Late 2025

The early versions of MindMappr focused on building the core chat interface, basic tool execution, and the glassmorphism UI.

*   **v4.0:** Introduced 9 basic execution tools (TTS, image generation, PDF creation, Python execution, web scraping) and chat persistence.
*   **v3.0:** Implemented the 8-tab UI structure and initial CI/CD integrations.
*   **v2.0:** Added file upload/download capabilities and basic task history.
*   **v1.0:** The initial release featured the core web chat UI with the dark cinematic theme and basic LLM routing.
