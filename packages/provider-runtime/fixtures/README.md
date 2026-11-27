# Recorded fixtures

Each fixture is one redacted turn of the prompt "Write hello.txt containing the word hi, then run cat hello.txt.", recorded with `scripts/record-fixture.ts` in a temporary cwd and HOME. `src/fixtures.test.ts` replays every fixture.

CLIProxy is an OpenAI-compatible gateway (`/v1/chat/completions`); the CLI's provider config goes in through `--home`.

| Harness                                    | Model                 | Route                         | Recorded or why not                                                                                                                        |
| ------------------------------------------ | --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Gemini CLI (`acp`, agent `gemini`)         | gemini-3.8-flash-high | Gemini CLI login              | Recorded: `gemini.events.jsonl`. No exit code over ACP                                                                                     |
| Antigravity (`antigravity`)                | gemini-3.8-flash-high | T3's Antigravity Google login | Recorded: `antigravity.events.jsonl`. The model `default` is rejected as unavailable, so pass a model id                                   |
| OpenCode (`opencode`)                      | claude-haiku-5-5      | CLIProxy                      | Recorded: `opencode.events.jsonl`                                                                                                          |
| Pi (`pi`)                                  | claude-haiku-5-5      | CLIProxy                      | Recorded: `pi.events.jsonl`. Usage arrives as `thread.token-usage.updated`, not on `turn.completed`                                        |
| Kimi Code (`acp`, agent `kimi-code`)       | claude-haiku-5-5      | CLIProxy                      | Recorded: `kimi-code.events.jsonl`. Its first `cat` ran before the write and failed; the retry printed hi. No usage and no exit code       |
| Kimi CLI (`acp`, agent `kimi`)             | —                     | —                             | Not recorded: MoonshotAI/kimi-cli is archived at 1.52.0 and prints a deprecation notice on stdout, which breaks ACP. Kimi Code replaces it |
| Grok (`grok`)                              | grok-4.7              | Grok login                    | Not recorded: the turn fails with 402, usage balance exhausted. The model `default` is rejected as unknown                                 |
| Cursor (`cursor`)                          | —                     | Cursor login                  | Not recorded: no Cursor login on the recording machine                                                                                     |
| Kiro, Fx, Muse, Copilot, Devin, Droid, OMP | —                     | —                             | Testkit only                                                                                                                               |
