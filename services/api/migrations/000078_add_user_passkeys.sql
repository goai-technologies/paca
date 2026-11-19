-- WebAuthn passkeys as an additional second factor. A user may register any
-- number; one passkey assertion satisfies the same login step a TOTP code does.
-- credential_id is split out of the credential blob so a lookup and the
-- uniqueness guarantee don't depend on parsing JSON; credential holds the
-- whole go-webauthn Credential (public key, sign counter, flags, transports).
-- The public key is not a secret, so unlike user_mfa.secret_enc it is not
-- encrypted, and passkeys work without ENCRYPTION_KEY.
CREATE TABLE IF NOT EXISTS user_passkeys (
    id             UUID PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id  BYTEA NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    credential     JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys (user_id);
