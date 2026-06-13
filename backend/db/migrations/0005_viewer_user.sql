-- Shared read-only family login. Set its password with set-password.ts.
-- Viewers see the owner's (admin's) data read-only; never see eBird credentials.
INSERT INTO users (username, display_name, password_hash, role)
VALUES ('family', 'Family', '!unset', 'viewer')
ON CONFLICT (username) DO NOTHING;
