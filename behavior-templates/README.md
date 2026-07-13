# Behavior templates

New instances should set `behavior.dir = "behavior-templates/generic"` and
configure owner metadata in `config/codex-chat.toml`:

```toml
[behavior]
dir = "behavior-templates/generic"

[owner]
name = "Example Owner"
telegramChatId = 123456789
trustedRemotes = ["example/*"]

[paths]
logicRepo = "/srv/assistant-agent-logic"
assistantWorkspace = "/srv/assistant-workspace"
```

Set `[paths]` to the new instance's actual checkouts. The generic pack
substitutes owner and path tokens when prompts are loaded.
Existing personal instances can continue using `behavior.dir = "behavior"`;
that pack is separate and unchanged.
