A pull request of mine has failing checks. Find out why and fix it.

The item below names the pull request's repository (`fields.repository`), its number and the checks that failed.

1. Check that this folder is a clone of that repository: one of `git remote -v` must point at it. If none does, stop
   and tell me; don't check anything out.
2. Check out the pull request in this worktree: `gh pr checkout <number> --repo <repository>`.
3. Read the failing checks' logs (`gh pr checks <number> --repo <repository>`, then `gh run view --log-failed`).
4. Reproduce the failure with the project's own test command, fix the cause, and run the checks again.
5. Commit the fix to the pull request's branch and push it. Don't merge, and don't change unrelated code.

If the failure isn't caused by the pull request (a flaky test, a broken runner), say so instead of changing code.
