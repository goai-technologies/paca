# Frontend Plugin System

## Overview

The Paca frontend plugin system is built on **Vite Module Federation** (via `@module-federation/vite`). The core `apps/web` application acts as the **host**. Each plugin ships as a **remote entry** — a separately built JavaScript bundle that exposes React components through a well-known contract defined by `@paca-ai/plugin-sdk-react`.

Plugins are loaded lazily when the user first navigates to a surface that has an active plugin registered for it. No plugin code is fetched until it is needed.

## Concepts

### Remote Entry

Each plugin build produces:
- `remoteEntry.js` — the Module Federation remote entry, served from the plugin's CDN URL.
- `plugin.json` — the plugin manifest (also read by the backend).
- Optional static assets (CSS, images) co-located with the remote entry.

### Extension Point Registry

At application startup the host fetches the list of enabled plugins from the API (`GET /api/v1/plugins`). Each record contains:

```ts
interface InstalledPlugin {
  id: string;               // e.g. "com.paca.bdd"
  version: string;          // semver
  remoteEntryUrl: string;   // CDN URL to remoteEntry.js
  extensionPoints: ExtensionPointRegistration[];
  config: Record<string, unknown>; // plugin-defined public config
}

interface ExtensionPointRegistration {
  point: ExtensionPointId;  // e.g. "task.detail.section"
  component: string;        // exported component name in the remote module
  label: string;            // display label used in drag-to-reorder UIs
  order: number;            // default render position (ascending)
  scope?: string;           // e.g. a projectId for project-scoped points
}
```

The host builds an **Extension Point Registry** — a `Map<ExtensionPointId, ExtensionPointRegistration[]>` — and makes it available to all host components via a React context (`PluginRegistryContext`).

### Plugin Context

Each plugin component receives a strongly-typed **context prop** from the host. The context shape is specific to the extension point:

```ts
// task.detail.section
interface TaskDetailContext {
  taskId: string;
  projectId: string;
  task: TaskSummary; // read-only snapshot
  permissions: ProjectPermissions;
  sdk: PluginSDK;
}

// sidebar.project.section
interface ProjectSidebarContext {
  projectId: string;
  permissions: ProjectPermissions;
  sdk: PluginSDK;
}

// project.settings.tab
interface ProjectSettingsContext {
  projectId: string;
  permissions: ProjectPermissions;
  sdk: PluginSDK;
}

// view
interface ViewContext {
  projectId: string;
  viewId: string;
  filters: TaskFilters;
  permissions: ProjectPermissions;
  sdk: PluginSDK;
}
```

The `PluginSDK` object exposes the plugin's backend API client (scoped to `/api/v1/plugins/{pluginId}/`) and a set of UI utility functions (toast, confirmation dialog, navigation). Plugins **cannot** import Paca's internal React Query cache or TanStack Router instances.

## Host-Side Implementation

### `PluginRegistryContext`

```
apps/web/src/lib/plugins/
  registry.ts          ← fetches installed plugins, builds the registry
  context.tsx          ← React context + provider
  loader.tsx           ← lazy remote component loader with error boundary
  extension-point.tsx  ← <ExtensionPoint id="task.detail.section" ctx={...} />
```

#### `<ExtensionPoint>`

The primary rendering primitive. Renders all registered components for a given extension point in order:

```tsx
<ExtensionPoint id="task.detail.section" context={taskDetailCtx} />
```

Internally it:
1. Looks up registrations from the registry context.
2. For each registration, lazily loads the remote component with `React.lazy` + dynamic `import()` via Module Federation.
3. Wraps each in an `<ErrorBoundary>` so a broken plugin cannot crash the host.
4. Passes the typed context as a prop.

#### `<PluginSlot>`

A lower-level primitive for rendering a single named slot in a layout (used for sidebar sections):

```tsx
<PluginSlot
  point="sidebar.project.section"
  scope={projectId}
  context={sidebarCtx}
/>
```

### Extension Point Placement

The following host components become **aware** of extension points after implementation:

| Host Component | Extension Point Rendered |
|---|---|
| `app-sidebar.tsx` | `sidebar.general.section` |
| Project sidebar section in `app-sidebar.tsx` | `sidebar.project.section` |
| Task detail drawer/page | `task.detail.section` |
| Project settings page | `project.settings.tab` |
| View selector / board area | `view` |

### Deep-linking to a settings tab

The project settings page keeps its open tab in the URL hash, so a tab can be linked to and survives a reload. A plugin can send the browser back to its own tab after leaving the app (an external setup flow, for example):

| Hash | Opens |
|---|---|
| `#general`, `#roles`, `#task-statuses`, … | that built-in tab |
| `#plugin:<pluginId>:<component>` | one specific `project.settings.tab` component |
| `#plugin:<pluginId>` | the plugin's first settings tab |

A hash that names nothing the member can see (an unknown id, a tab they lack permission for, a plugin that isn't loaded) is ignored and the default tab opens. Build the link from `window.location` with only the hash replaced, so it stays on the current project.

### Plugin pages and callbacks

A plugin can own whole pages, not just fragments. A page is a component registered at a page extension point plus a `navItems` entry that gives it a slug:

| `navItems[].scope` | Extension point | Route | Listed in |
|---|---|---|---|
| `project` | `project.page` | `/projects/:projectId/plugins/:pluginId/:slug` | project sidebar |
| `admin` | `admin.page` | `/admin/plugins/:pluginId/:slug` | admin sidebar |
| `app` | `app.page` | `/plugin-pages/:pluginId/:slug` | nowhere (reached by URL) |

The prefix is `/plugin-pages/`, not `/plugins/`: the gateway reserves `/plugins/*` for the plugins' static frontend assets (`/plugins/<id>/assets/remoteEntry.js`), so a page under it would never reach the web app.

An `app` page exists for **callbacks**: an external service (a GitHub App manifest/installation, an OAuth provider) sends the browser back to a URL, and that URL has to be a page on the Paca origin. Pointing the service at a plugin *backend* route instead does not work for a browser redirect — the redirect carries no `Authorization` header and the short-lived access-token cookie may have expired during the detour, so the host answers with a bare `AUTH_UNAUTHENTICATED` JSON document.

An `app` page avoids that because it lives under the authenticated layout:

1. If the access token expired, the host refreshes it from the refresh cookie before the page mounts.
2. If the session is gone entirely, the host sends the user to sign in with `?redirect=<this URL>` and returns them here afterwards, with the callback's query string intact. Only same-origin paths are honoured as redirect targets.
3. The plugin component then calls **its own backend** through the injected `api` client — as the signed-in user, through the same route gates (`requireActions`, …) as any other call — and navigates on with the result.

Declare a `requiredPermission` on the nav item: without one, any signed-in user can open the page. Treat the query string as untrusted input and have the backend validate it (a one-time `state` bound to the user who started the flow, for example).

```json
{
  "frontend": {
    "extensionPoints": [{ "point": "app.page", "component": "CallbackPage" }],
    "navItems": [
      {
        "scope": "app",
        "slug": "callback",
        "label": "Setup callback",
        "component": "CallbackPage",
        "requiredPermission": "myplugin:manage"
      }
    ]
  }
}
```

### Drag-to-Reorder

Extension point registrations include an `order` field. The **super admin** can reorder plugin panels within a surface (e.g., reorder task detail sections) from the admin settings UI. The order is persisted as a system-wide setting via `PATCH /api/v1/admin/plugin-extension-settings` and applied for all users on load.

## Plugin Build Setup

A plugin's frontend uses Vite with `@module-federation/vite`:

```ts
// vite.config.ts (plugin)
import { federation } from "@module-federation/vite";

export default {
  plugins: [
    react(),
    federation({
      name: "paca-plugin-bdd",
      filename: "remoteEntry.js",
      exposes: {
        "./TaskDetailSection": "./src/TaskDetailSection.tsx",
        "./ProjectSettingsTab": "./src/ProjectSettingsTab.tsx",
      },
      shared: ["react", "react-dom", "@paca-ai/plugin-sdk-react"],
    }),
  ],
  build: { target: "esnext" },
};
```

Shared libraries (`react`, `react-dom`, `@paca-ai/plugin-sdk-react`) are marked as shared so the host's singleton instances are used. This prevents duplicate React instances and ensures the plugin SDK is the same object the host provides.

## Content Security Policy

The server must allowlist plugin CDN origins in the `Content-Security-Policy` header:

```
Content-Security-Policy:
  script-src 'self' https://plugins.paca.app https://cdn.example.com;
  connect-src 'self' https://plugins.paca.app;
```

Plugin CDN origins are configurable per-installation in the server config.

## Error Handling

Each remote component is wrapped in an `<ErrorBoundary>`. If the remote entry fails to load (network error, version mismatch) or the component throws at render time, the boundary renders a non-disruptive inline error with a "Retry" option. The rest of the page remains functional.

## Plugin Extension Settings

The **super admin** can configure system-wide extension point settings:
- **Hide** individual plugin panels per extension point for all users.
- **Reorder** panels within an extension point for all users.

Settings are stored in `plugin_extension_settings` (keyed by `plugin_id` + `extension_point`, no user scope) and applied by the host when building the plugin registry for every user.

## Security Considerations

- Plugin bundles are loaded over HTTPS only.
- The host never passes authentication tokens or internal session state to plugins; plugin HTTP calls are authenticated via the same session cookie as the host (same-origin or subdomain with `credentials: "include"`).
- Plugins are executed in the same browsing context as the host. For higher isolation (untrusted third-party plugins), future work can sandbox plugins in `<iframe>` elements with `sandbox` attributes.
- Plugin code is not run through any host-side eval; Module Federation uses standard ES module loading.
