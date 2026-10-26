# AGENTS.md

Pi package that delegates work to persistent Cursor ACP workers. See README.md for behavior.

- Layout: `lib/*.mjs` dependency-free core (ACP connection, profile, state, worker manager); `extensions/cursor.ts` thin Pi adapter; `skills/`, `prompts/`; `test/` with a fake ACP agent in `test/fixtures/fake-acp.mjs`.
- Keep the core dependency-free and runnable with `node --test`. Host packages stay `peerDependencies` with `*`.
- Before finishing a change, run `npm test` and `npm run check`. When the extension changes, also run `npm run smoke:extension` with `PI_PACKAGE_DIR` set. `npm run smoke:live` uses real Cursor; run it only when asked.
- Add a fake-agent scenario and a test for every protocol behavior you change.
- Invariants: the model profile (context 1m, effort >= high, fast false) is set and verified before every prompt and never downgraded; tool arguments never control the model or permissions; no fresh-session fallback when load fails; never auto-resend a failed prompt; permission requests fail closed without UI; question-shaped permission requests and `cursor/ask_question` are never answered; the run timeout/abort covers setup and the prompt.
- Wording: the permission policy gates only requests Cursor sends (not reads, in-workspace edits, or allowlisted actions); modes are not sandboxes; `end_turn` does not prove success.
- Prefer delegating exploration, implementation, and tests to workers when orchestrating; keep decisions in the orchestrator.
- Never commit secrets, local state, or personal provider/model settings. Do not commit or push unless asked.
