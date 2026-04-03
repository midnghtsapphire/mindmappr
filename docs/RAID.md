# RAID: Risks, Assumptions, Issues, Dependencies

This document identifies and tracks the Risks, Assumptions, Issues, and Dependencies associated with the MindMappr Command Center project.

## Risks

The project faces several architectural and operational risks that require mitigation strategies.

The primary risk is the **Single-File Architecture Scaling**. The `server.mjs` file currently exceeds 3,000 lines of code, encompassing routing, API endpoints, agent orchestration, and database interactions. As the application grows and more agents or features are added, maintaining and debugging this single file will become increasingly difficult. This monolithic structure increases the likelihood of merge conflicts and introduces a single point of failure for the entire backend logic.

Another significant risk was the **Ephemeral Storage Vulnerability**, which has now been fixed. Initially, the application stored critical data, such as API keys and user connections, in local JSON files. When deployed to DigitalOcean App Platform, these files were wiped during every deployment or container restart, causing users to lose their configurations. The migration to SQLite mitigated this risk, but it highlighted the danger of not accounting for the target environment's storage characteristics during the initial design phase.

A critical operational risk was the **Force-Push Vulnerability**, which resulted in the loss of significant code contributions. Because the repository lacked branch protection rules, multiple teams were able to push directly to the `master` branch. A force-push by one team inadvertently overwrote the commits of others, leading to the temporary loss of the Activity Window and Rex Tools features. This incident underscores the risk of operating without a formal, PR-based workflow and branch protection.

## Assumptions

The development and deployment of MindMappr rely on several key assumptions about external services and infrastructure.

A fundamental assumption is the **OpenRouter Availability**. MindMappr depends entirely on OpenRouter as the gateway for its LLM calls. The system assumes that OpenRouter will maintain high availability, provide consistent API response times, and continue to support the required models (e.g., Claude 3.5 Sonnet). Any prolonged outage or significant API changes from OpenRouter would directly impact the core functionality of the agents.

The project also assumes **DO App Platform Reliability**. The deployment strategy is built around DigitalOcean App Platform, relying on its ability to manage the Node.js environment, handle scaling, and maintain the integrity of the SQLite database file across container restarts. The assumption is that DO App Platform will continue to provide a stable environment for the application to run continuously without data loss.

Finally, the architecture assumes that **SQLite is Sufficient for Scale**. While SQLite is excellent for single-user or low-traffic scenarios, the assumption is that it will perform adequately as the primary database for the Command Center. If the application scales to support multiple concurrent users or highly intensive agent workflows, the limitations of SQLite (e.g., write concurrency) may necessitate a migration to a more robust database solution like PostgreSQL.

## Issues

This section documents known issues and past incidents that have impacted the project.

The most critical issue was the **April 3 Force-Push Incident** (Issue #2). Multiple teams (Credentials, Activity Window, Content Studio) were working concurrently and pushing directly to the `master` branch. The Content Studio team executed a force-push, which inadvertently overwrote the commits from the other teams, resulting in the loss of the `rex-tools.mjs` file, the Activity Window features, and the tool-use loop in the server. A mega-fix team was required to merge all features back together from the git history.

Another major issue was the **Connections and API Keys Ephemeral Storage Bug** (Issue #3). Connections and API keys were stored in local JSON files (`data/connections.json`), which were wiped on every deploy on DigitalOcean App Platform. This forced users to re-enter all tokens every time. The resolution was to migrate all file-based persistence to SQLite.

Related to the storage bug was the **Connections Panel Cosmetic Bug** (Issue #4). The Connections panel allowed users to enter API tokens, but these tokens were never actually used by Rex or any agent. The connection status was purely cosmetic. The resolution involved adding a `getConnectionToken(serviceId)` function and wiring the Rex tools to check the SQLite connections table first.

Other notable issues include the need to **Implement Branch Protection** (Issue #5) to prevent future force-pushes, and the need to **Verify the Activity Window** (Issue #6) and **Verify Rex Tools** (Issue #7) functionality after the mega-merge commit.

## Dependencies

MindMappr relies on specific software versions, libraries, and external APIs to function correctly.

The primary runtime dependency is **Node.js 20**. The application is built and tested against this version, and the Dockerfile explicitly uses the `node:20-slim` image. Compatibility with older or newer versions is not guaranteed.

For database operations, the application depends heavily on **better-sqlite3**. This library requires native compilation, which necessitates build tools (`make`, `g++`, `python3`) during the `npm install` phase, as configured in the Dockerfile.

The AI capabilities are entirely dependent on the **OpenRouter API**. The system requires a valid OpenRouter API key to function and assumes the availability of the `anthropic/claude-sonnet-4` model, among others.

Deployment relies on the **DO App Platform**. The application is designed to be deployed as an App on DigitalOcean, utilizing its build and runtime environment.

Finally, the Rex tools depend on the **GitHub API** for repository management, pull requests, and file operations. The tools require a valid GitHub Personal Access Token (PAT) with appropriate scopes to execute these functions autonomously.
