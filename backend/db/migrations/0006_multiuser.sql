-- Multi-user: per-user data scope + per-owner gallery source.
--
-- views_user_id: the owner whose data this account reads. NULL for normal users
-- (they read their own data — strict isolation). The transitional `family`
-- viewer points at the admin so she keeps seeing his data read-only until
-- per-user sharing (#2) lands.
--
-- gallery_url: the account's photo-gallery source (gaylon.photos). Only owners
-- with a URL get gallery features; everyone else sees a graceful empty state.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS views_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS gallery_url TEXT;

-- The `family` viewer reads the admin owner's data (transitional).
UPDATE users
   SET views_user_id = (SELECT id FROM users WHERE username = 'gaylon')
 WHERE username = 'family' AND views_user_id IS NULL;

-- The owner's photo source (the gaylon.photos birds collection).
UPDATE users
   SET gallery_url = 'https://gaylon.photos/api/photos?collection=birds'
 WHERE username = 'gaylon' AND gallery_url IS NULL;
