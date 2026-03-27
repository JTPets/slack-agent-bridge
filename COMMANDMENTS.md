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
11. Never run pm2 delete all. SqTools is production. Only restart bridge-agent and auto-update by name. Never touch sqtools.
