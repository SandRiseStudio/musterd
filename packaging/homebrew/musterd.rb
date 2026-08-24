# frozen_string_literal: true

# Homebrew formula for musterd (ADR 156) — npm package via registry tarball.
# Source of truth in the musterd monorepo; copy to SandRiseStudio/homebrew-musterd as Formula/musterd.rb
#
#   brew tap SandRiseStudio/musterd
#   brew trust sandrisestudio/musterd   # first time (Homebrew tap trust)
#   brew install musterd
#
# After an npm publish:
#   pnpm bump-brew-formula --version X.Y.Z

class Musterd < Formula
  desc "Muster your agents and humans into persistent teams"
  homepage "https://github.com/SandRiseStudio/musterd"
  url "https://registry.npmjs.org/@musterd/cli/-/cli-0.4.2.tgz"
  sha256 "aa53247c839ba3b4a03c67a684794ab4445ae0f52e6cbd424172f4cf36382cd6"
  license "MIT"

  # better-sqlite3 (via @musterd/server) needs a supported Node ABI — pin Node 22 (engines >=22).
  depends_on "node@22"

  def install
    node22 = Formula["node@22"].opt_bin
    ENV.prepend_path "PATH", node22

    # Avoid Homebrew's std_npm_args (--min-release-age blocks fresh publishes; --build-from-source
    # breaks better-sqlite3 when prebuilds exist). Use node@22 + allow prebuilds.
    system "npm", "install", "-ddd", "--global",
           "--cache=#{HOMEBREW_CACHE}/npm_cache",
           "--prefix=#{libexec}",
           "--min-release-age=0",
           cached_download

    # Shebang `env node` can pick Homebrew's latest node (26+); bind the bin to node@22.
    (bin/"musterd").write <<~EOS
      #!/bin/bash
      exec "#{node22}/node" "#{libexec}/lib/node_modules/@musterd/cli/dist/bin.js" "$@"
    EOS
  end

  def caveats
    <<~EOS
      musterd runs on Node 22 (Homebrew node@22).

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
