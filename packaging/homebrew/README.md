# SandRiseStudio/homebrew-musterd
#
# Custom Homebrew tap for musterd (ADR 156). The formula is an **npm-wrapper**: it depends on
# Node ≥22 and installs `@musterd/cli@<version>` from the npm registry.
#
## Create the tap (human, one-time)
#
# 1. Create an empty GitHub repo: `SandRiseStudio/homebrew-musterd`
# 2. Copy this directory's contents into that repo:
#
#        mkdir -p Formula
#        cp packaging/homebrew/musterd.rb Formula/musterd.rb
#        # optional: copy this README to the tap root
#        git add Formula README.md && git commit -m "musterd 0.3.0" && git push
#
# 3. Users install with:
#
#        brew tap SandRiseStudio/musterd
#        brew install musterd
#        musterd init
#
## After each npm release
#
# From the musterd monorepo (after `pnpm release`):
#
#        pnpm bump-brew-formula --version 0.3.0
#        # then commit + push the updated Formula/musterd.rb in homebrew-musterd
#
# The monorepo path `packaging/homebrew/musterd.rb` is the source of truth until the tap exists;
# keep them in sync.
#
## Why not homebrew-core yet
#
# Dogfood the custom tap first. A core formula needs a stable release cadence and review; revisit
# after 0.3.x has been published and smoke-tested.
