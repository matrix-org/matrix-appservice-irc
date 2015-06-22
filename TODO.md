
- The AS bot should set its own matrix display name (configurable)
- For `!commands`, if there is only 1 IRC network configured, we should allow it
  to not be specified.
- private rooms should have join_rules and topic set to level:0 so anyone can
  edit them. join_rules so that users can manually set rooms to public/publish
  an alias for them.
- You can send messages in channels you are not a part of (e.g. `Github123`),
  we should probably send that from the AS bot rather than pollute the member
  list in this case.
- We need to do win95 style `LONGNA~1` semantics for virtual IRC usernames. We
  should persist the `~#` bit forever so bans are fixed directly to a user ID.
