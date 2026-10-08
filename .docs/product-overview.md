# QueryForge — Product Overview and Development Requirements

**Product Name:** QueryForge  
**Product Type:** Cross-platform Desktop Database Query and Exploration Tool  
**Version:** 1.0 (MVP)  
**Status:** Initial Product Definition  
**Tagline:** Craft Queries. Explore Data.

## 1. Product Overview

QueryForge is a modern desktop application designed for software developers, database engineers, and technical users who need to connect to, query, explore, and export data from multiple database technologies.

The application will provide an experience similar to JetBrains DataGrip, with an initial focus on:

- Microsoft Azure Cosmos DB for NoSQL
- Microsoft Azure SQL Database

QueryForge will provide a unified interface for managing database connections, writing and executing queries, viewing results, and exporting data.

The application should be responsive, intuitive, and optimized for developer productivity.

Although the initial release focuses on Azure databases, the architecture should support adding other database engines in future releases.

## 2. Primary Objectives

1. Provide a single desktop application for querying multiple database technologies.
2. Allow users to create, configure, test, save, edit, and delete database connections.
3. Provide an advanced query editor with syntax highlighting, formatting, and autocomplete.
4. Support multiple query editor tabs and simultaneous database connections.
5. Display query results in multiple formats, including tables and JSON.
6. Support exporting query results to local files.
7. Protect database credentials and connection information.
8. Provide an extensible architecture for adding database providers.

## 3. Target Platforms

The application should support:

- macOS (Apple Silicon and Intel, subject to packaging support)
- Windows
- Linux (future or optional for MVP)

The application will run locally on the user's computer, rather than requiring a hosted web application or centralized backend service.

Database queries will execute directly from the desktop application to the configured database endpoints.

## 4. Core Features

### 4.1 Database Connection Manager

Users must be able to create and manage multiple database connections.

**Common functionality:**

- Create new connections.
- Edit existing connections.
- Delete saved connections.
- Test connectivity.
- Connect and disconnect.
- Assign friendly connection names.
- Organize connections into groups or folders.
- Display connection status.
- Remember recently used connections.
- Store authentication credentials securely.

**Azure Cosmos DB connection settings:**

- Connection name
- Azure Cosmos DB endpoint
- Authentication method
- Account key or Microsoft Entra ID authentication
- Database selection
- Container selection
- Optional connection timeout

**Azure SQL connection settings:**

- Connection name
- Server hostname
- Port (default 1433)
- Database name
- Authentication method
- SQL username and password
- Microsoft Entra ID authentication
- Encryption and TLS settings
- Connection timeout

Microsoft Entra ID authentication should be supported where practical, particularly for enterprise Azure environments.

**Security requirements:**

- Credentials must never be stored in plaintext.
- Prefer operating-system credential storage.
- Never log passwords, account keys, or access tokens.
- Provide secure connection handling.
- Support TLS and certificate validation.
- Avoid embedding authentication secrets in exported application settings.

### 4.2 Database Object Explorer

A navigation panel will allow users to browse the objects available through a connection.

**Azure Cosmos DB:**

- Accounts/connections
- Databases
- Containers
- Container properties
- Partition key definitions
- Sample documents
- Document inspection

**Azure SQL:**

- Databases
- Schemas
- Tables
- Views
- Columns and data types
- Primary keys
- Indexes
- Stored procedures (future enhancement)

The explorer should support refreshing metadata without restarting the application.

Double-clicking an object should provide relevant actions, such as opening a query editor or viewing sample records.

### 4.3 Query Editor

The central workspace will contain a code editor optimized for database queries.

**Required features:**

- SQL syntax highlighting.
- Cosmos DB for NoSQL query syntax support.
- Automatic indentation.
- Query formatting.
- Line numbers.
- Bracket and parenthesis matching.
- Find and replace.
- Undo and redo.
- Keyboard shortcuts.
- Autocomplete for SQL keywords.
- Optional metadata-aware autocomplete for tables, containers, and columns.
- Multiple query editor tabs.
- Save queries to local files.
- Open previously saved queries.
- Execute the current query.
- Execute selected query text.
- Cancel running queries.
- Display query execution progress.

**Query execution shortcuts:**

- `Cmd+Enter` on macOS
- `Ctrl+Enter` on Windows/Linux

The query editor should support long queries and retain its contents when switching between tabs.

For the MVP, each query tab should have an explicit active database connection and database context.

### 4.4 Query Execution Engine

QueryForge must execute queries using the appropriate database provider.

**Azure Cosmos DB:**

- Execute Cosmos DB for NoSQL queries.
- Support queries scoped to a container.
- Support cross-partition queries where applicable.
- Handle continuation tokens.
- Support paginated results.
- Display execution duration.
- Display request charge (RU) when available.
- Handle Cosmos DB throttling and retry responses.
- Allow cancellation.

**Azure SQL:**

- Execute SQL queries.
- Support SELECT queries.
- Support multiple SQL statements where practical.
- Support query timeouts.
- Support result pagination or incremental retrieval.
- Display execution duration.
- Support cancellation.
- Display SQL execution errors with useful details.

**Execution behavior:**

- Query execution must not freeze the user interface.
- Multiple tabs should operate independently.
- Errors should be displayed without losing the original query.
- Large result sets should be processed incrementally.
- Queries should respect configured timeouts.

### 4.5 Query Results Viewer

The bottom portion of the workspace will display results returned by the query engine.

**Table view:**

- Column headers
- Row numbers
- Resizable columns
- Horizontal and vertical scrolling
- Copy individual cells
- Copy selected rows
- Copy selected values
- Display NULL values clearly
- Support large results efficiently using virtualized rendering

**JSON view:**

- Pretty-printed JSON
- Collapsible objects and arrays
- Syntax highlighting
- Copy JSON
- Save JSON
- View complete document values

**Additional capabilities:**

- Display total rows loaded.
- Display execution duration.
- Display query errors.
- Display Cosmos DB RU charges.
- Support switching between table and JSON views without re-executing the query.
- Allow users to expand a cell containing an object or array into a detailed JSON inspector.

Azure Cosmos DB documents frequently contain nested objects and arrays, so JSON inspection is an important feature.

### 4.6 Export Query Results

Users must be able to export query results to files on their local computer.

**MVP formats:**

- CSV
- JSON

**Future formats:**

- Excel XLSX
- JSON Lines (JSONL)
- SQL INSERT statements

**Export behavior:**

- Export currently loaded rows.
- Optionally export all matching rows using continued retrieval.
- Select output file location.
- Show export progress.
- Allow cancellation.
- Handle large result sets using streaming where possible.
- Preserve native JSON structure for JSON exports.
- Properly escape CSV values.
- Use UTF-8 encoding.

The application must clearly distinguish between exporting the currently loaded result set and exporting all matching records.

### 4.7 Query History and Saved Queries

QueryForge should help users reuse frequently executed queries.

**Features:**

- Automatically maintain local query history.
- Save frequently used queries.
- Reopen previous queries.
- Search query history.
- Associate saved queries with a connection or database type.
- Display the last execution time.
- Display execution status and duration.

Query history should be stored locally and should avoid persisting sensitive query parameters unless the user explicitly enables that behavior.

## 5. Proposed User Interface

The layout should be familiar to developers who have used DataGrip, DBeaver, or similar tools.

### Main application layout

**Left Sidebar — Database Explorer**

Contains saved connections, connected databases, containers, schemas, and tables.

**Center — Query Workspace**

Contains multiple query editor tabs with syntax highlighting, formatting, and execution controls.

**Bottom — Results Panel**

Contains tabular results, JSON results, query execution metadata, and export controls.

**Top Toolbar**

Contains connection management, query execution, formatting, save, and general application actions.

**Status Bar**

Displays active connection, query status, execution duration, row count, and Cosmos DB request charge where relevant.

### Suggested wireframe

```text
+-------------------------------------------------------------+
| QueryForge                                                  |
+-------------------------------------------------------------+
| Connections | New Query | Run | Format | Save | Settings     |
+------------------+------------------------------------------+
| DATABASES        | Query 1 | Query 2 | Query 3              |
|                  +------------------------------------------+
| > Cosmos Dev     | Connection: Cosmos Dev                   |
|   > Database1    |                                          |
|     > Orders     | SELECT *                                 |
|     > Customers  | FROM c                                   |
|                  | WHERE c.orderType = 'CONTACT'             |
| > Azure SQL Dev  |                                          |
|   > dbo          |                                          |
|     > Provider   |                                          |
|     > Orders     |                                          |
|                  +------------------------------------------+
|                  | Results | JSON | Messages                |
|                  +------------------------------------------+
|                  | id       | orderType | status            |
|                  |----------|-----------|-------------------|
|                  | 123      | CONTACT   | CREATED           |
|                  | 456      | CONTACT   | COMPLETE          |
|                  |                                          |
|                  +------------------------------------------+
|                  | 2 rows | 145ms | 4.32 RU | Export         |
+------------------+------------------------------------------+
```

## 6. Technical Architecture

The architecture should separate presentation, query execution, database-specific logic, connection management, and local persistence.

### Primary components

**Desktop Application Shell**

Provides the native desktop application experience, window management, menus, keyboard shortcuts, and local filesystem access.

**User Interface**

Implements the connection explorer, query editor, results grid, JSON viewer, and application settings.

**Connection Manager**

Manages saved connection profiles, authentication, connection initialization, and connection lifecycle.

**Query Execution Service**

Coordinates query execution, cancellation, result pagination, error handling, and metrics collection.

**Database Provider Interface**

Defines a consistent contract for multiple database technologies.

Each database provider is responsible for database-specific operations.

**Cosmos DB Provider**

Uses the supported Azure Cosmos DB SDK to execute queries, retrieve metadata, handle continuation tokens, and retrieve query diagnostics.

**Azure SQL Provider**

Uses a Microsoft SQL Server-compatible driver to execute T-SQL queries and retrieve database metadata.

**Local Storage Service**

Persists application preferences, saved connections (excluding plaintext secrets), saved queries, and query history.

**Export Service**

Converts results into supported file formats and writes output incrementally.

### Conceptual architecture

```text
                 QueryForge Desktop
+---------------------------------------------------+
|                User Interface                     |
|                                                   |
|  Connection Explorer | Query Editor | Results     |
+---------------------------------------------------+
|             Application Services                  |
|                                                   |
|  Connection Manager | Query Engine | Export       |
|  Query History      | Metadata     | Settings     |
+---------------------------------------------------+
|             Database Provider API                 |
+----------------------+----------------------------+
| Cosmos DB Provider   | Azure SQL Provider         |
+----------------------+----------------------------+
           |                         |
           v                         v
     Azure Cosmos DB           Azure SQL Database

          Local Configuration / Credential Store
```

## 7. Extensibility

The application should use a provider-based architecture.

New database support should be added without significant changes to the main user interface.

Potential future providers include:

- PostgreSQL
- MySQL
- SQLite
- MongoDB
- Additional Azure database technologies

The common provider abstraction should handle connection lifecycle, query execution, cancellation, metadata discovery, and result delivery while allowing database-specific capabilities.

The design must not assume all databases support identical query languages, pagination strategies, result structures, or transaction semantics.

## 8. Non-Functional Requirements

**Performance**

- Fast application startup.
- Responsive editor and user interface.
- Virtualized result tables.
- Efficient handling of large query results.
- No requirement to load an entire result set into memory.
- Background or worker-based query execution.

**Security**

- Secure credential storage.
- Encrypted database connections.
- No sensitive values in application logs.
- Configurable query timeouts.
- Support for enterprise authentication.
- Read-only connection mode to reduce accidental data modification.

**Reliability**

- Clear handling of connectivity errors.
- Graceful handling of expired credentials.
- Recovery from network interruptions.
- Cancellation of long-running queries.
- Preservation of unsaved query text after unexpected shutdowns where feasible.

**Usability**

- Keyboard-oriented workflow.
- Resizable panels.
- Dark and light themes.
- Clear execution feedback.
- Support for high-resolution displays.

**Maintainability**

- Modular source structure.
- Unit tests for application services.
- Integration tests for database providers.
- Automated builds.
- Consistent error handling.
- Structured diagnostics and logging.

## 9. MVP Scope

The first version should concentrate on a reliable core query workflow.

| Feature | MVP Priority |
|---|---|
| Desktop application shell | Required |
| Azure Cosmos DB connections | Required |
| Azure SQL connections | Required |
| Create/save/edit/delete connections | Required |
| Secure credential storage | Required |
| Connection testing | Required |
| Basic database object explorer | Required |
| Query editor with highlighting | Required |
| Multiple query tabs | Required |
| Execute and cancel queries | Required |
| Tabular results viewer | Required |
| JSON results viewer | Required |
| CSV export | Required |
| JSON export | Required |
| Query execution timing | Required |
| Cosmos DB RU display | Required |
| Basic query history | Required |
| Query formatting | Required |
| Advanced intelligent autocomplete | Phase 2 |
| Advanced database object management | Phase 2 |
| Excel export | Phase 2 |
| Additional database providers | Phase 2 |
| Schema comparison | Future |
| Visual query builder | Future |

## 10. Initial Technical Decisions to Make

The following decisions should be made before implementation:

1. **Desktop Framework:** Electron, Tauri, or another cross-platform approach.
2. **UI Framework:** React with TypeScript or an equivalent modern UI framework.
3. **Query Editor:** Monaco Editor or CodeMirror.
4. **Data Grid:** A performant, virtualized grid supporting large result sets.
5. **Database Driver Strategy:** Native JavaScript/TypeScript SDKs versus a separate Java-based database execution service.
6. **Local Persistence:** SQLite, application configuration files, or a combination.
7. **Authentication:** Secure integration with operating-system credential stores and Microsoft Entra ID.
8. **Distribution:** Native installers and application packaging for macOS and Windows.

These decisions should account for developer experience, application performance, packaging complexity, security, and future extensibility.

## 11. Suggested Development Phases

### Phase 1 — Application Foundation

- Select the technology stack.
- Create the application shell.
- Establish the source structure.
- Implement application navigation and layout.
- Add local persistence.
- Implement connection profile management.

### Phase 2 — Database Connectivity

- Implement the database provider abstraction.
- Implement Azure Cosmos DB connectivity.
- Implement Azure SQL connectivity.
- Add connection testing.
- Implement initial metadata discovery.

### Phase 3 — Query Editing and Execution

- Integrate the query editor.
- Add syntax highlighting and formatting.
- Implement query execution.
- Implement cancellation.
- Add execution errors and diagnostic reporting.

### Phase 4 — Results and Export

- Implement the table viewer.
- Implement the JSON viewer.
- Add incremental result loading.
- Implement CSV export.
- Implement JSON export.
- Add execution metrics.

### Phase 5 — Productivity and Release

- Add query history.
- Add saved queries.
- Add keyboard shortcuts.
- Implement themes.
- Add automated tests.
- Package desktop installers.
- Perform security and performance testing.

## 12. Initial Definition of Done

The MVP is complete when a user can:

1. Install and open QueryForge on a supported desktop platform.
2. Create and save an Azure Cosmos DB connection.
3. Create and save an Azure SQL connection.
4. Securely authenticate and connect to either database.
5. Browse databases and their primary objects.
6. Open multiple independent query tabs.
7. Write and format queries with syntax highlighting.
8. Execute queries without blocking the interface.
9. Cancel a query in progress.
10. View query results as a table.
11. View structured results as JSON.
12. Inspect nested Cosmos DB documents.
13. Export results to CSV or JSON.
14. See execution duration, row counts, and relevant diagnostics.
15. Close and reopen the application without losing saved connections or saved queries.

## 13. Development Principles

- Start with a small, reliable MVP.
- Favor mature libraries over custom-built editor and grid components.
- Keep the interface consistent across database providers.
- Preserve database-specific features when useful.
- Make security and reliability foundational.
- Use pagination and streaming for scalability.
- Build a modular architecture that allows adding database engines later.
- Prioritize developer productivity and keyboard-friendly workflows.

## 14. Development Starting Point

Use this product overview as the basis for defining the software architecture and creating the initial application.

The first development task is to evaluate desktop frameworks and database SDK compatibility, then recommend a technology stack.

After selecting the stack, establish the repository structure, define the database provider contracts, and implement the first working vertical slice:

**Create a connection → Connect to a database → Execute a query → Display results → Export results.**

The goal is to have an end-to-end functional foundation before adding advanced features.
