import json

hooks = json.load(open(".claude/settings.local.json"))
rig = {"hooks": hooks.get("hooks", {})}
json.dump(rig, open("heal-probe-rig/hooks.settings.json", "w"), indent=2)

# The seat binding is NOT staged here: it carries a live agent_key and grant. run.sh reads it
# from this worktree at run time instead.
print("ok")
