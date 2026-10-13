-- Rolls back 0086_user_activity.sql (td-c8e6a3). Not auto-applied: move it
-- into migrations/ (renumbered to the next free number) in the same commit as
-- the code revert (the page-use report, /api/activity and Admin → Users). The recorded
-- usage days are discarded.
DROP TABLE user_activity_day;
