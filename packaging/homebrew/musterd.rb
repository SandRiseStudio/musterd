# frozen_string_literal: true

# Homebrew formula for musterd (ADR 156) — npm-wrapper.
# Source of truth in the musterd monorepo; copy to SandRiseStudio/homebrew-musterd as Formula/musterd.rb
#
#   brew tap SandRiseStudio/musterd
#   brew install musterd
#
# After an npm publish, bump `version` (and optionally pin npm) via:
#   pnpm bump-brew-formula --version X.Y.Z

class Musterd < Formula
  desc "Muster your agents and humans into persistent teams"
  homepage "https://github.com/SandRiseStudio/musterd"
  # Version tracks @musterd/cli on npm (lockstep with other @musterd/* packages).
  version "0.3.0"
  license "MIT"

  depends_on "node" => ">=22"

  def install
    # Install the published CLI into the Cellar prefix so `musterd` lands on PATH.
    # Uses the formula version so brew and npm stay aligned (ADR 156).
    system "npm", "install", "-g", "--prefix", libexec, "@musterd/cli@#{version}"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      musterd requires Node >=22 (Homebrew's `node` formula satisfies this).

      Next:
        musterd init

      Upgrade:
        brew upgrade musterd

      Packaged installs cannot `musterd service refresh` (that rebuilds a git checkout).
      Use `brew upgrade musterd` instead.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/musterd --version")
  end
end
