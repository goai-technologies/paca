# Service accounts API

A service account is a workspace-level, non-human account for integrations, CI and automation. It has a name, a description and an avatar, authenticates with its own API keys, and holds roles exactly like a user. It cannot sign in. Design: [Accounts model](../architecture/database-schema.md#accounts-model) and [authentication](../architecture/authorization.md#authentication-and-principals).

All paths are under `/api/v1/admin`. The envelope and error format are the usual ones ([roles and policies API](roles-and-policies.md)). Permissions are IAM actions on `service_account/*` (`service_accounts:read`, `service_accounts:write`); listing and creating are checked on `service_account/*`, one account on `service_account/{id}`.

## Object

```json
{
  "id": "uuid",
  "name": "CI bot",
  "description": "deploys",
  "created_by": "uuid",
  "roles": [{ "id": "uuid", "name": "Reader" }],
  "created_at": "2026-10-11T10:00:00Z",
  "updated_at": "2026-10-11T10:00:00Z",
  "avatar_url": "https://...",
  "avatar_thumb_url": "https://..."
}
```

`roles` are the workspace roles the account holds, sorted by name (empty for a new account). `avatar_*` are omitted when there is no avatar. `name` is 1-100 characters, `description` at most 1000.

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/service-accounts` | `service_accounts:read` | List the live service accounts by name, cursor-paginated: `{items, page_size, next_cursor, total_count}`. Query: `page_size` (1-100, default 30), `cursor`, `page` (numbered paging for tables, instead of `cursor`; echoed back with `next_cursor` null), `search` (every word must appear in the name or description). |
| `POST` | `/service-accounts` | `service_accounts:write` | Create `{name, description?}`. The account holds no role until it is given some. |
| `GET` | `/service-accounts/{id}` | `service_accounts:read` | One account (`404 SERVICE_ACCOUNT_NOT_FOUND`; a user or agent id is not one). |
| `PATCH` | `/service-accounts/{id}` | `service_accounts:write` | Change `name` and/or `description`. |
| `DELETE` | `/service-accounts/{id}` | `service_accounts:write` | Soft-delete it: its keys stop working, its role attachments and project memberships are removed. |
| `POST` | `/service-accounts/{id}/avatar/initiate-upload`, `.../complete-upload`; `DELETE .../avatar` | `service_accounts:write` | Avatar, same flow as users and agents. |
| `GET` | `/service-accounts/{id}/api-keys` | `service_accounts:read` | Active keys (prefix, expiry, last use), newest first and cursor-paginated: `{items, page_size, next_cursor, total_count}` (`cursor` or `page`, `page_size` ≤ 100). The key itself is never listed. |
| `POST` | `/service-accounts/{id}/api-keys` | `service_accounts:write` | Mint a key `{name, expires_at?}`; the response carries `key` **once**. The caller must also hold `roles:assign` on every role the account currently holds (`403` otherwise), because the key lets its holder act with those roles. |
| `DELETE` | `/service-accounts/{id}/api-keys/{keyId}` | `service_accounts:write` | Revoke a key. |
| `GET` | `/service-accounts/{id}/roles` | `roles:read` and `service_accounts:read` | The account's workspace roles. |
| `PUT` | `/service-accounts/{id}/roles` | `service_accounts:write` and `roles:assign` per role added or removed | Replace the set: `{"role_ids": [...]}`. |

The three `api-keys` routes need a signed-in **session**: an API key cannot list, mint or revoke keys (`403 FORBIDDEN`), so a leaked key cannot create more credentials.

Minting a key is therefore bounded by the same authority as assigning the account's roles: `service_accounts:write` alone cannot borrow a more privileged account's access. Only platform-wide roles are checked; project roles are managed through project membership.

Agents' own keys behave differently (revoking one rotates it): see [authentication](../architecture/authorization.md#authentication-and-principals).

## Using a key

Send it as `X-API-Key: paca_...` or `Authorization: ApiKey paca_...`. The request is judged by the service account's own roles and nothing else. For project access, add the account to the project with `POST /projects/{projectId}/members` and `{"service_account_id": "...", "role_ids": [...]}` (exactly one of `user_id`, `agent_id`, `service_account_id`); project-scoped roles only apply while it is a member. In member listings it appears with `member_type: "service_account"` and a `service_account_id`.

`service_accounts:write` is root-equivalent over what the account may do (it mints its keys), so grant it like `roles:assign`. `SUPER_ADMIN` holds it; `ADMIN` does not.
