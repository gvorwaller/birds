-- Personal appearance belongs to the signed-in user, never their data owner.
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'
  CHECK (theme IN ('light', 'dark', 'forest', 'ocean', 'paper'));
