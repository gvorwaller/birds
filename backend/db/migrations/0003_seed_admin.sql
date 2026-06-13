-- Bootstrap admin user. The placeholder hash can never verify; set a real
-- password with: npx tsx --env-file=.env scripts/set-password.ts
INSERT INTO users (username, display_name, password_hash, role)
VALUES ('gaylon', 'Gaylon', '!unset', 'admin')
ON CONFLICT (username) DO NOTHING;
