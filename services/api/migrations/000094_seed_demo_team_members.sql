-- 000094_seed_demo_team_members.sql
-- Seeds default team members across projects to enable assigning work and member-select fields

BEGIN;

-- 1. Alex Morgan
INSERT INTO accounts (id, kind, name, description)
VALUES ('11111111-1111-1111-1111-111111111111', 'user', 'Alex Morgan', 'Frontend Lead')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('11111111-1111-1111-1111-111111111111', 'alexmorgan', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'alex.morgan@paca.ai', 'user')
ON CONFLICT (id) DO NOTHING;

-- 2. Sarah Chen
INSERT INTO accounts (id, kind, name, description)
VALUES ('22222222-2222-2222-2222-222222222222', 'user', 'Sarah Chen', 'Backend Engineer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('22222222-2222-2222-2222-222222222222', 'sarahchen', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'sarah.chen@paca.ai', 'user')
ON CONFLICT (id) DO NOTHING;

-- 3. David Kim
INSERT INTO accounts (id, kind, name, description)
VALUES ('33333333-3333-3333-3333-333333333333', 'user', 'David Kim', 'Full Stack Developer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('33333333-3333-3333-3333-333333333333', 'davidkim', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'david.kim@paca.ai', 'user')
ON CONFLICT (id) DO NOTHING;

-- 4. Emily Watson
INSERT INTO accounts (id, kind, name, description)
VALUES ('44444444-4444-4444-4444-444444444444', 'user', 'Emily Watson', 'Product Designer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('44444444-4444-4444-4444-444444444444', 'emilywatson', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'emily.watson@paca.ai', 'user')
ON CONFLICT (id) DO NOTHING;

-- 5. Michael Scott
INSERT INTO accounts (id, kind, name, description)
VALUES ('55555555-5555-5555-5555-555555555555', 'user', 'Michael Scott', 'Engineering Manager')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('55555555-5555-5555-5555-555555555555', 'michaelscott', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'michael.scott@paca.ai', 'user')
ON CONFLICT (id) DO NOTHING;

-- Attach to all projects as project members
INSERT INTO project_members (id, project_id, account_id)
SELECT gen_random_uuid(), p.id, a.id
FROM projects p
CROSS JOIN (
    VALUES 
        ('11111111-1111-1111-1111-111111111111'::uuid),
        ('22222222-2222-2222-2222-222222222222'::uuid),
        ('33333333-3333-3333-3333-333333333333'::uuid),
        ('44444444-4444-4444-4444-444444444444'::uuid),
        ('55555555-5555-5555-5555-555555555555'::uuid)
) AS a(id)
ON CONFLICT DO NOTHING;

-- Attach Editor role in each project
INSERT INTO role_attachments (role_id, project_id, account_id)
SELECT r.id, p.id, a.id
FROM projects p
JOIN roles r ON r.project_id = p.id AND r.name = 'Editor'
CROSS JOIN (
    VALUES 
        ('11111111-1111-1111-1111-111111111111'::uuid),
        ('22222222-2222-2222-2222-222222222222'::uuid),
        ('33333333-3333-3333-3333-333333333333'::uuid),
        ('44444444-4444-4444-4444-444444444444'::uuid),
        ('55555555-5555-5555-5555-555555555555'::uuid)
) AS a(id)
ON CONFLICT DO NOTHING;

COMMIT;
