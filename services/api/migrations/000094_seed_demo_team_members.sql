-- 000094_seed_demo_team_members.sql
-- Seeds default team members across projects to enable assigning work and member-select fields

BEGIN;

-- 1. Niyata Bhat
INSERT INTO accounts (id, kind, name, description)
VALUES ('11111111-1111-1111-1111-111111111111', 'user', 'Niyata Bhat', 'Frontend Lead')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('11111111-1111-1111-1111-111111111111', 'niyatabhat', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'niyata.bhat@goai.solutions', 'user')
ON CONFLICT (id) DO NOTHING;

-- 2. Tejesh
INSERT INTO accounts (id, kind, name, description)
VALUES ('22222222-2222-2222-2222-222222222222', 'user', 'Tejesh', 'Backend Engineer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('22222222-2222-2222-2222-222222222222', 'tejesh', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'tejesh@goai.solutions', 'user')
ON CONFLICT (id) DO NOTHING;

-- 3. Sachin Kumar
INSERT INTO accounts (id, kind, name, description)
VALUES ('33333333-3333-3333-3333-333333333333', 'user', 'Sachin Kumar', 'Full Stack Developer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('33333333-3333-3333-3333-333333333333', 'sachinkumar', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'sachin.kumar@goai.solutions', 'user')
ON CONFLICT (id) DO NOTHING;

-- 4. Prakruti V
INSERT INTO accounts (id, kind, name, description)
VALUES ('44444444-4444-4444-4444-444444444444', 'user', 'Prakruti V', 'Product Designer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('44444444-4444-4444-4444-444444444444', 'prakruti', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'prakruti.v@goai.solutions', 'user')
ON CONFLICT (id) DO NOTHING;

-- 5. Mohammed Samiwala
INSERT INTO accounts (id, kind, name, description)
VALUES ('55555555-5555-5555-5555-555555555555', 'user', 'Mohammed Samiwala', 'Engineering Manager')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, username, password_hash, email, kind)
VALUES ('55555555-5555-5555-5555-555555555555', 'mohammedsami', '$2a$10$7LmUtT9fUBEdNdEvD1RdquHU5Xavg05ayNGwENlh4NFJq7JSwjJE6', 'mohammed.samiwala@goai.solutions', 'user')
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

