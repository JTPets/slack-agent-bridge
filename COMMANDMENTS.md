# COMMANDMENTS

Core rules that must NEVER be violated. These are non-negotiable.

1. Never log tokens, API keys, or secrets to console or files.
2. Never use eval() or child_process.exec(). Use spawn() only.
3. Never commit tokens or secrets to git.
4. Never run git push --force or git branch -D on main.
5. Never delete or overwrite .env files on the Pi.
6. Always report errors to Slack. No silent failures.
7. Always clean up temp directories in finally blocks.
8. Always run tests before committing.
9. Always add regression tests for bug fixes.
10. Always add LOGIC CHANGE comments when modifying business logic.
11. Never run pm2 delete all. SqTools is production — never touch sqtools. (The bridge itself has no PM2: it is the `jt-agent` container, restarted by name with `docker compose restart jt-agent`. `auto-update.js` is not a running process — nothing starts it — so there is no auto-update process to restart. Verified 2026-09-14.)
