# SandRiseStudio/homebrew-musterd
#
# Custom Homebrew tap for musterd (ADR 156). Formula downloads `@musterd/cli` from the npm
# registry and installs with Homebrew's `std_npm_args`.
#
## Install
#
#        brew tap SandRiseStudio/musterd
#        brew trust sandrisestudio/musterd   # required once on modern Homebrew
#        brew install musterd
#        musterd init
#
## After each npm release
#
# From the musterd monorepo:
#
#        pnpm bump-brew-formula --version X.Y.Z
#        # copy packaging/homebrew/musterd.rb → Formula/musterd.rb here and push
#
## Why not homebrew-core yet
#
# Dogfood the custom tap first. A core formula needs a stable release cadence and review; revisit
# after 0.3.x has been published and smoke-tested.
