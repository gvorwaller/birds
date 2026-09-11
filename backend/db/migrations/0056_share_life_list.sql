-- Account owners explicitly opt in to sharing their life list with other
-- signed-in Birds users. Existing private lists stay private. Family viewer
-- access remains separate and cannot grant sharing of the linked owner's data.
ALTER TABLE users ADD COLUMN share_life_list boolean NOT NULL DEFAULT false;
