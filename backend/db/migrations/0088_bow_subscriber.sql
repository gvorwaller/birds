-- Birds of the World subscription is personal: it belongs to the signed-in
-- account, never its data owner. It only decides whether species pages show a
-- Birds of the World link; no Cornell credentials are stored for it (sign-in
-- happens on birdsoftheworld.org in the user's own browser).
ALTER TABLE users ADD COLUMN bow_subscriber boolean NOT NULL DEFAULT false;
